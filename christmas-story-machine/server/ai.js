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
Contribution type: ${c.type === 'drawing' ? 'a hand-drawn picture (photographed)' : 'a family photograph'}
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

export function chooseStyle(text, sceneCount) {
  const n = words(text);
  // Short, single-moment, action-y stories become a little animated scene;
  // longer or multi-moment memories become a narrated Ken Burns slideshow.
  if (n <= 70 && sceneCount <= 2) return 'animated';
  return 'slideshow';
}

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
- "animated": a single lively illustrated scene with gentle motion. Use it for short, simple stories (roughly 70 words or fewer) centered on one moment or action, especially from young children.
- "slideshow": a narrated Ken Burns slideshow of 2-6 illustrated scenes. Use it for longer stories, memories with several moments, reflective or reverent stories, or stories with many people and places.

Split the story into scenes (1-2 for animated, 2-6 for slideshow). Each scene's narration is the contributor's own words for that part of the story, lightly tidied, so that all the narrations together tell the whole story in order. Pick each scene's setting, time of day, mood and up to 5 picture elements from the allowed lists so the picture matches what is happening; prefer people elements (child, adult, grandparent, family) when the story is about people.
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
    if (words(c.text) > 140 || scenes.length > 2) style = 'slideshow';
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
const KEYWORDS = [
  [/\b(jesus|baby jesus|manger|nativity|bethlehem|mary|joseph)\b/, { setting: 'nativity-stable', elements: ['manger', 'star', 'sheep'], mood: 'reverent' }],
  [/\b(shepherds?|wise ?m[ae]n|magi|angels?)\b/, { setting: 'nativity-stable', elements: ['shepherd', 'angel', 'star'], mood: 'reverent' }],
  [/\b(church|chapel|mass|choir|hymn|carols?|pray(ed|er|ing)?)\b/, { setting: 'church', elements: ['family', 'star'], mood: 'reverent' }],
  [/\b(santa|sleigh|north pole|elves|elf)\b/, { setting: 'snowy-night', elements: ['santa', 'sleigh', 'reindeer'], mood: 'magical' }],
  [/\b(reindeer|rudolph)\b/, { setting: 'snowy-night', elements: ['reindeer', 'moon'], mood: 'magical' }],
  [/\b(snowman|snowball|sledd?(ing|e)?|snow ?angel)\b/, { setting: 'winter-village', elements: ['snowman', 'child', 'sled'], mood: 'joyful' }],
  [/\b(cookies?|bak(e|ed|ing)|kitchen|gingerbread|cocoa|hot chocolate|dinner|ham|turkey|pie)\b/, { setting: 'kitchen', elements: ['cookies', 'grandparent', 'child', 'cocoa'], mood: 'cozy' }],
  [/\b(presents?|gifts?|unwrap|tree|stockings?|fireplace|ornaments?)\b/, { setting: 'cozy-living-room', elements: ['christmas-tree', 'presents', 'family'], mood: 'cozy' }],
  [/\b(piano|sang|sing(ing)?|song)\b/, { setting: 'cozy-living-room', elements: ['piano', 'family', 'candles'], mood: 'joyful' }],
  [/\b(read|book|story ?time)\b/, { setting: 'cozy-living-room', elements: ['books', 'grandparent', 'child'], mood: 'cozy' }],
  [/\b(dog|puppy)\b/, { elements: ['dog'] }],
  [/\b(cat|kitten)\b/, { elements: ['cat'] }],
  [/\b(car|drove|drive|road trip)\b/, { setting: 'winter-village', elements: ['car'], mood: 'joyful' }],
  [/\b(beach|ocean|summer|swim)\b/, { setting: 'beach', elements: ['family'], mood: 'joyful' }],
  [/\b(forest|woods|hike)\b/, { setting: 'snowy-forest', elements: ['pine-trees', 'family'], mood: 'peaceful' }],
  [/\b(grandma|grandpa|nana|papa|granny|grandmother|grandfather|abuela|abuelo|oma|opa)\b/, { elements: ['grandparent'] }],
  [/\b(mom|dad|mommy|daddy|mother|father|aunt|uncle)\b/, { elements: ['adult'] }],
  [/\b(brother|sister|cousins?|baby)\b/, { elements: ['child'] }],
  [/\b(star|stars|night sky)\b/, { elements: ['star'] }],
  [/\b(moon)\b/, { elements: ['moon'] }],
  [/\b(house|home)\b/, { setting: 'home-exterior' }],
];

function sceneFor(text) {
  const t = text.toLowerCase();
  let setting = null;
  let mood = null;
  const elements = [];
  for (const [re, m] of KEYWORDS) {
    if (!re.test(t)) continue;
    if (m.setting && !setting) setting = m.setting;
    if (m.mood && !mood) mood = m.mood;
    for (const e of m.elements || []) if (!elements.includes(e)) elements.push(e);
  }
  setting = setting || 'cozy-living-room';
  if (!elements.some((e) => ['child', 'adult', 'grandparent', 'family', 'santa', 'shepherd'].includes(e))) elements.push('family');
  if (setting === 'cozy-living-room' && !elements.includes('christmas-tree')) elements.unshift('christmas-tree');
  return {
    setting,
    timeOfDay: /\b(morning|afternoon|sunny|day)\b/.test(t) || setting === 'beach' ? 'day' : 'night',
    mood: mood || 'cozy',
    elements: elements.slice(0, 5),
    stockQuery: `christmas ${setting.replace(/-/g, ' ')}`,
  };
}

export function offlinePlan(c) {
  const text = tidy(c.text, config.maxStoryChars);
  const sentences = text.match(/[^.!?…]+[.!?…]*["”']?/g)?.map((s) => s.trim()).filter(Boolean) || [text];
  const n = words(text);
  // Pack sentences into on-screen-sized chunks (~220 characters), at most 8 scenes.
  const pieces = sentences.flatMap((s) => (s.length <= 230 ? [s] : s.match(/.{1,200}(\s|$)/g).map((x) => x.trim())));
  let chunks = [];
  for (const p of pieces) {
    const last = chunks[chunks.length - 1];
    if (last && (last + ' ' + p).length <= 220) chunks[chunks.length - 1] = `${last} ${p}`;
    else chunks.push(p);
  }
  while (chunks.length > 8) {
    // merge the shortest neighbouring pair until it fits
    let best = 0;
    for (let i = 1; i < chunks.length - 1; i++) if (chunks[i].length + chunks[i + 1].length < chunks[best].length + chunks[best + 1].length) best = i;
    chunks.splice(best, 2, `${chunks[best]} ${chunks[best + 1]}`);
  }
  const scenes = chunks.map((chunk) => ({ narration: tidy(chunk, 420), ...sceneFor(chunk) }));
  return {
    style: chooseStyle(text, scenes.length),
    styleReason: n <= 70 ? 'Short and simple, so it becomes one animated scene.' : 'Longer story, so it becomes a narrated slideshow.',
    title: c.title ? tidy(c.title, 60) : `${c.name ? `${c.name}’s` : 'A'} Christmas Story`,
    caption: c.caption ? tidy(c.caption, 140) : fallbackCaption({ type: 'story', name: c.name, age: c.age, title: c.title, seed: c.id }),
    scenes,
  };
}
