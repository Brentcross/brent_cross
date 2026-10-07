// Claude does three jobs here, all through structured (JSON-schema) output:
//   1. review a guest's submission for anything a host would want to see first,
//   2. write a warm caption / narration line when the guest didn't give one,
//   3. plan a text story: pick slideshow vs. animated scene and break it into
//      scenes chosen from the curated art library (server/art/scene.js).
// Without an API key (or if a call fails) the offline planner and template
// captions below take over, so the night never depends on the network.
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { config } from './config.js';
import { SETTINGS, ELEMENTS, TIMES, MOODS } from './art/scene.js';
import { fallbackCaption, isSafeNarration, reviewGuestText, tidy } from './guardrails.js';
import { storyboard, chooseStyle } from './storyboard.js';

export { chooseStyle };

const client = config.aiEnabled ? new Anthropic({ maxRetries: 3, timeout: 120_000 }) : null;

// Simple concurrency limiter so a burst of 60 submissions doesn't fire 60 API calls at once.
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= config.aiConcurrency) await new Promise((res) => waiting.push(res));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const SYSTEM = `You help a family turn their Christmas Eve into a keepsake video. Guests of every age, from toddlers to grandparents, submit short stories, drawings and photos during the evening; the video is revealed to the whole family, including young children, at the end of the night.

Everything you write will be read aloud or shown on screen to that audience. Write warmly and simply, with gentle humor where it fits and reverence where the subject is sacred (the Nativity, prayer, church, remembering loved ones who have passed). Never be sarcastic, scary, romantic, or edgy, never mention brands, and never say anything that could spoil the magic of Santa for small children.

Honor the contributor's own voice. A child's story should still sound like the child told it; tidy only spelling and run-on sentences. Never invent facts about real people beyond what the contributor wrote or what is visible in the picture.

Hold for host review (safe=false) only when the submission contains something a host would plausibly not want shown to the whole family without looking first: profanity, cruelty, mature or frightening content, private information like addresses or phone numbers, or anything clearly hurtful about a person. Ordinary family teasing, silly stories, and sad-but-loving memories are fine. When safe=false, write a short neutral holdReason for the host; captions should still be gentle.`;

const json = (s) => ({ type: 'json_schema', schema: s });

const CAPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['safe', 'holdReason', 'caption', 'narration'],
  properties: {
    safe: { type: 'boolean' },
    holdReason: { type: 'string', description: 'Empty when safe' },
    caption: { type: 'string', description: 'On-screen caption, at most 90 characters' },
    narration: { type: 'string', description: 'One or two warm sentences a narrator could read aloud, at most 200 characters' },
  },
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['safe', 'holdReason', 'style', 'styleReason', 'title', 'caption', 'scenes'],
  properties: {
    safe: { type: 'boolean' },
    holdReason: { type: 'string' },
    style: { type: 'string', enum: ['slideshow', 'animated'] },
    styleReason: { type: 'string' },
    title: { type: 'string', description: 'Short title, at most 50 characters' },
    caption: { type: 'string', description: 'One-line introduction card text, at most 90 characters' },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['narration', 'setting', 'timeOfDay', 'mood', 'elements', 'stockQuery'],
        properties: {
          narration: { type: 'string', description: 'The words shown and read for this scene, at most 200 characters' },
          setting: { type: 'string', enum: SETTINGS },
          timeOfDay: { type: 'string', enum: TIMES },
          mood: { type: 'string', enum: MOODS },
          elements: { type: 'array', items: { type: 'string', enum: ELEMENTS } },
          stockQuery: { type: 'string', description: 'Two to four plain words describing a wholesome stock photo for this scene, no people names' },
        },
      },
    },
  },
};

async function callClaude({ content, schema, effort = 'low', maxTokens = 4000 }) {
  const base = {
    model: config.anthropicModel,
    max_tokens: maxTokens,
    system: SYSTEM,
    messages: [{ role: 'user', content }],
    output_config: { effort, format: json(schema) },
  };
  let response;
  try {
    // Server-side fallback re-runs a declined request on Anthropic's recommended model.
    response = await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    response = await client.messages.create(base); // e.g. a gateway that doesn't know the fallback beta
  }
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function imageBlock(file) {
  const buf = await sharp(file, { failOn: 'none' }).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } };
}

function describeContributor(c) {
  return [`Contributor: ${c.name || 'a family member'}`, c.age ? `Age: ${c.age}` : null, c.family ? `Family/household: ${c.family}` : null, c.title ? `Their title: ${c.title}` : null]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------- captions for drawings & photos
export async function captionMedia(c, originalPath) {
  const guest = reviewGuestText(c.title, c.caption);
  const base = {
    safe: guest.ok,
    holdReason: guest.ok ? '' : `Guest text ${guest.reasons.join('; ')}`,
    caption: c.caption ? tidy(c.caption, 140) : fallbackCaption({ type: c.type, name: c.name, age: c.age, title: c.title, seed: c.id }),
    narration: '',
    source: 'template',
  };
  if (!client) return base;
  try {
    const content = [];
    if (config.aiVision && originalPath) content.push(await imageBlock(originalPath));
    content.push({
      type: 'text',
      text: `${describeContributor(c)}
Contribution type: ${c.type === 'drawing' ? (c.source === 'board' ? 'a picture drawn with a finger on a tablet' : 'a hand-drawn picture (photographed)') : c.source === 'booth' ? 'a photo-booth selfie with festive props (hat, antlers or a holly frame)' : 'a family photograph'}
${c.caption ? `The contributor wrote this caption, keep it as the caption (tidy only): ${c.caption}` : 'The contributor did not write a caption; write one.'}

Write the on-screen caption and a narration line for this piece of the Christmas Eve keepsake. ${c.type === 'drawing' ? 'Celebrate the artist and what they drew (describe it kindly; if unsure what it is, say so playfully rather than guessing wrong).' : 'Describe the moment warmly without guessing names of people you cannot identify.'}`,
    });
    const out = await limited(() => callClaude({ content, schema: CAPTION_SCHEMA }));
    if (!out) return base;
    const caption = c.caption ? base.caption : tidy(out.caption, 140);
    const narration = tidy(out.narration, 240);
    return {
      safe: base.safe && out.safe,
      holdReason: [base.holdReason, out.safe ? '' : out.holdReason].filter(Boolean).join(' · '),
      caption: isSafeNarration(caption) || c.caption ? caption : base.caption,
      narration: isSafeNarration(narration) ? narration : '',
      source: 'claude',
    };
  } catch (err) {
    console.warn('[ai] caption failed, using template:', err.message);
    return base;
  }
}

// ---------------------------------------------------------------- story planning
const words = (s) => (String(s).match(/\S+/g) || []).length;

export async function planStory(c) {
  const guest = reviewGuestText(c.text, c.title, c.caption);
  const offline = offlinePlan(c);
  const fallback = { ...offline, safe: guest.ok, holdReason: guest.ok ? '' : `Guest text ${guest.reasons.join('; ')}`, source: 'offline' };
  if (!client) return fallback;
  try {
    const out = await limited(() =>
      callClaude({
        effort: 'medium',
        schema: PLAN_SCHEMA,
        content: `${describeContributor(c)}

Their story:
"""
${c.text}
"""

Turn this into a short segment of the family's Christmas Eve video.

Choose the style:
- "animated": one to three lively illustrated scenes with gentle motion. Use it for short, simple stories (roughly 70 words or fewer), especially from young children.
- "slideshow": a narrated Ken Burns slideshow of 2-6 illustrated scenes. Use it for longer stories, memories with several moments, reflective or reverent stories, or stories with many people and places.

Split the story into scenes (1-3 for animated, 2-6 for slideshow), starting a new scene whenever the place or time changes ("then", "in the morning", "afterward"). Each scene's narration is the contributor's own words for that part of the story, lightly tidied, so that all the narrations together tell the whole story in order.

Each scene's picture must show what is happening in that moment:
- setting: where the action takes place in this moment (baking cookies is the kitchen; leaving them under the tree is the living room). Ignore places or people that are only mentioned.
- timeOfDay: when this moment happens; a later "in the morning" does not change earlier scenes.
- elements (up to 5): the people who are actually there, then the key objects. Draw the storyteller when they say "I" or "we" (child, adult or grandparent by their age, or as a child when they say "when I was little"); "mom", "dad", "aunt" are adult. Draw Santa only if he appears in the moment, not when something is left for him. Use empty-plate when the treats have been eaten. Never add people or things the story does not mention, except a christmas-tree in the living room.
${c.caption ? `The contributor wrote this caption, use it for "caption" (tidy only): ${c.caption}` : 'Write a one-line caption introducing the story and its teller.'}
${c.title ? `Keep their title: ${c.title}` : 'Give it a short title.'}`,
      }),
    );
    if (!out || !Array.isArray(out.scenes) || !out.scenes.length) return fallback;
    const scenes = out.scenes.slice(0, 6).map((s, i) => ({
      narration: isSafeNarration(s.narration) ? tidy(s.narration, 240) : offline.scenes[Math.min(i, offline.scenes.length - 1)].narration,
      setting: s.setting,
      timeOfDay: s.timeOfDay,
      mood: s.mood,
      elements: s.elements,
      stockQuery: tidy(s.stockQuery, 60),
    }));
    let style = out.style === 'animated' || out.style === 'slideshow' ? out.style : chooseStyle(c.text, scenes.length);
    if (words(c.text) > 140 || scenes.length > 3) style = 'slideshow';
    const title = c.title ? tidy(c.title, 60) : isSafeNarration(out.title) ? tidy(out.title, 60) : offline.title;
    const caption = c.caption ? tidy(c.caption, 140) : isSafeNarration(out.caption) ? tidy(out.caption, 140) : offline.caption;
    return {
      safe: guest.ok && out.safe,
      holdReason: [fallback.holdReason, out.safe ? '' : out.holdReason].filter(Boolean).join(' · '),
      style,
      styleReason: tidy(out.styleReason, 200),
      title,
      caption,
      scenes,
      source: 'claude',
    };
  } catch (err) {
    console.warn('[ai] plan failed, using offline planner:', err.message);
    return fallback;
  }
}

// ---------------------------------------------------------------- offline planner
export function offlinePlan(c) {
  const text = tidy(c.text, config.maxStoryChars);
  const scenes = storyboard(text, { age: c.age }).map((s) => ({ ...s, narration: tidy(s.narration, 420), stockQuery: `christmas ${s.setting.replace(/-/g, ' ')}` }));
  const style = chooseStyle(text, scenes.length);
  return {
    style,
    styleReason: style === 'animated' ? 'Short story with a few clear moments, so it becomes animated scenes.' : 'Longer story, so it becomes a narrated slideshow.',
    title: c.title ? tidy(c.title, 60) : `${c.name ? `${c.name}’s` : 'A'} Christmas Story`,
    caption: c.caption ? tidy(c.caption, 140) : fallbackCaption({ type: 'story', name: c.name, age: c.age, title: c.title, seed: c.id }),
    scenes,
  };
}
