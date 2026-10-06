// Turns one contribution into a finished, self-contained video segment, and
// stitches finished segments into the final keepsake.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { eventDir, getEvent, updateContribution, updateEvent } from './store.js';
import { captionMedia, planStory } from './ai.js';
import { renderSceneLayers, snowLayerSvg, titleCardSvg } from './art/scene.js';
import { bylineFor, captionOverlay, decodableSource, drawingFrame, photoFrame, svgToFrame, writeEmptyOverlay } from './media.js';
import { animatedShot, compileFinal, joinShots, kenBurnsShot, posterFrame, probeDuration } from './render.js';
import { speak, ttsEnabled } from './tts.js';
import { builtInMusic } from './music.js';
import { fetchStockPhoto } from './stock.js';

const words = (s) => (String(s || '').match(/\S+/g) || []).length;
// Comfortable reading time for on-screen text, in seconds.
const readTime = (text, min = 5, max = 15) => Math.min(max, Math.max(min, 2.2 + words(text) / 2.6));

const INDOOR = new Set(['cozy-living-room', 'kitchen']);

async function narrationAudio(text, file) {
  if (!ttsEnabled() || !text) return { audio: null, seconds: 0 };
  try {
    await speak(text, file);
    return { audio: file, seconds: await probeDuration(file) };
  } catch (err) {
    console.warn('[tts]', err.message);
    return { audio: null, seconds: 0 };
  }
}

// ------------------------------------------------------------------ per-contribution processing
// Stage 1 — words: caption / narration / story plan, plus a safety review.
// Skipped on a re-render after the host edited the words by hand.
export async function writeWords(eventId, cid) {
  const ev = getEvent(eventId);
  const c = ev?.contributions.find((x) => x.id === cid);
  if (!c) return false;
  const set = (patch) => updateContribution(eventId, cid, patch);
  if ((c.keepWords || c.wordsDone) && (c.type !== 'story' || c.plan)) return true;
  await set({ status: 'writing', statusDetail: c.type === 'story' ? 'Planning the story…' : 'Writing a caption…' });
  let review;
  if (c.type === 'story') {
    const plan = await planStory(c);
    review = plan;
    await set({ plan, autoCaption: plan.caption, autoTitle: plan.title, style: plan.style, narration: plan.scenes.map((s) => s.narration).join(' ') });
  } else {
    const cap = await captionMedia(c, eventDir(eventId, 'media', cid, c.files.original.name));
    review = cap;
    await set({ autoCaption: cap.caption, narration: cap.narration });
  }
  const needsReview = !review.safe || ev.settings.requireReview;
  if (needsReview && !c.approved) {
    await set({ review: { held: true, reason: review.safe ? 'Waiting for host approval' : review.holdReason || 'Flagged for a quick look' } });
  } else {
    await set({ review: { held: false } });
  }
  await set({ wordsDone: true, status: 'queued', statusDetail: 'Waiting for the video maker…' });
  return true;
}

// Stage 2 — pictures: render the segment (even when held, so approval is instant).
export async function renderContribution(eventId, cid) {
  const c = getEvent(eventId)?.contributions.find((x) => x.id === cid);
  if (!c) return;
  const dir = eventDir(eventId, 'media', cid);
  const work = path.join(dir, 'work');
  await fs.mkdir(work, { recursive: true });
  await updateContribution(eventId, cid, { status: 'rendering', statusDetail: 'Making the video…' });
  const segment = path.join(dir, 'segment.mp4');
  const tmp = path.join(work, 'segment.tmp.mp4');
  const duration = await renderSegment(c, dir, work, tmp);
  await fs.rename(tmp, segment);
  await posterFrame(segment, path.join(dir, 'poster.jpg'), Math.min(2.5, duration / 2)).catch(() => {});
  await updateContribution(eventId, cid, { status: 'ready', statusDetail: '', keepWords: false, segment: { file: 'segment.mp4', duration, renderedAt: new Date().toISOString() }, error: null });
  await fs.rm(work, { recursive: true, force: true });
}

export async function processContribution(eventId, cid) {
  if (await writeWords(eventId, cid)) await renderContribution(eventId, cid);
}

function captionFor(c) {
  return c.caption || c.autoCaption || '';
}

async function renderSegment(c, dir, work, out) {
  if (c.type === 'drawing' || c.type === 'photo') {
    const src = await decodableSource(path.join(dir, c.files.original.name), path.join(work, 'decoded.png'));
    const frame = path.join(work, 'frame.jpg');
    const overlay = path.join(work, 'overlay.png');
    const caption = captionFor(c);
    const drawing = c.type === 'drawing';
    const byline = `${drawing && c.title ? `“${c.title}” · ` : ''}${bylineFor(c, drawing ? 'Drawn by' : 'Shared by')}`;
    // Drawings get no heading and a two-line caption so nothing overlaps the artwork.
    await captionOverlay({ caption, byline, heading: drawing ? '' : c.title || '' }, overlay, { compact: drawing });
    const narr = await narrationAudio(c.narration || caption, path.join(work, 'narration.mp3'));
    const duration = Math.max(readTime(caption, 6, 11), narr.seconds + 1.6);
    let motion;
    if (c.type === 'drawing') {
      const { cx, cy } = await drawingFrame(src.path, frame);
      // Barely-there push toward the artwork; the drawing itself never changes.
      motion = { z0: 1.0, z1: 1.04, x0: 0.5, x1: cx, y0: 0.4, y1: Math.min(cy, 0.4) };
    } else {
      await photoFrame(src.path, frame);
      const dirn = c.seq % 2 ? 1 : -1;
      motion = { z0: 1.02, z1: 1.14, x0: 0.5 - 0.2 * dirn, x1: 0.5 + 0.2 * dirn, y0: 0.4, y1: 0.55 };
    }
    await kenBurnsShot({ frame, overlay, out: path.join(work, 'shot0.mp4'), duration, motion, audio: narr.audio });
    return joinShots([{ file: path.join(work, 'shot0.mp4'), duration }], out);
  }

  // Text story
  const plan = c.plan;
  const shots = [];
  const title = c.title || c.autoTitle || '';
  const byline = bylineFor(c, 'A story by');
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];
    const layers = renderSceneLayers(scene, `${c.id}-${i}`);
    const overlay = path.join(work, `overlay${i}.png`);
    await captionOverlay({ caption: scene.narration, byline: i === 0 ? byline : '', heading: i === 0 ? title : '' }, overlay);
    const narr = await narrationAudio(scene.narration, path.join(work, `narration${i}.mp3`));
    const duration = Math.max(readTime(scene.narration), narr.seconds + 1.6);
    const file = path.join(work, `shot${i}.mp4`);

    if (plan.style === 'animated') {
      const bg = path.join(work, `bg${i}.jpg`);
      const ch = path.join(work, `ch${i}.png`);
      const pt = path.join(work, `pt${i}.png`);
      await svgToFrame(layers.background, bg);
      await sharp(Buffer.from(layers.characters)).png().toFile(ch);
      const indoor = INDOOR.has(layers.scene.setting);
      const particles = indoor ? snowLayerSvg(`${c.id}${i}`, 2160, 70).replace(/fill="#fff"/g, 'fill="#ffd77a"') : snowLayerSvg(`${c.id}${i}`);
      await sharp(Buffer.from(particles)).png().toFile(pt);
      await animatedShot({ background: bg, characters: ch, particles: pt, particleMode: indoor ? 'sparkle' : 'snow', overlay, out: file, duration, audio: narr.audio, seed: c.seq + i });
    } else {
      const frame = path.join(work, `frame${i}.jpg`);
      const stock = config.pexelsKey && scene.stockQuery ? await fetchStockPhoto(scene.stockQuery, path.join(work, `stock${i}.jpg`)) : null;
      if (stock) await photoFrame(stock, frame);
      else await svgToFrame(layers.full, frame);
      const moves = [
        { z0: 1.0, z1: 1.15, x0: 0.3, x1: 0.6, y0: 0.6, y1: 0.5 },
        { z0: 1.15, z1: 1.02, x0: 0.7, x1: 0.4, y0: 0.4, y1: 0.55 },
        { z0: 1.04, z1: 1.18, x0: 0.5, x1: 0.5, y0: 0.7, y1: 0.45 },
        { z0: 1.12, z1: 1.0, x0: 0.2, x1: 0.55, y0: 0.5, y1: 0.5 },
      ];
      await kenBurnsShot({ frame, overlay, out: file, duration, motion: moves[(i + c.seq) % moves.length], audio: narr.audio });
    }
    shots.push({ file, duration });
  }
  return joinShots(shots, out);
}

// ------------------------------------------------------------------ title cards
async function cardClip({ title, subtitle, out, work, duration = 4.5, seed }) {
  const frame = path.join(work, `${seed}.jpg`);
  const overlay = path.join(work, `${seed}-ov.png`);
  await svgToFrame(titleCardSvg({ title, subtitle, seed }), frame);
  await writeEmptyOverlay(overlay);
  const shot = path.join(work, `${seed}-shot.mp4`);
  await kenBurnsShot({ frame, overlay, out: shot, duration, motion: { z0: 1.0, z1: 1.06, y0: 0.4, y1: 0.4 } });
  return joinShots([{ file: shot, duration }], out, { edgeFade: 0.8 });
}

// ------------------------------------------------------------------ final compilation
export function orderedContributions(ev) {
  const list = ev.contributions.filter((c) => c.status === 'ready' && !c.hidden && !c.review?.held);
  const bySeq = (a, b) => (a.order ?? a.seq) - (b.order ?? b.seq);
  list.sort(bySeq);
  if (ev.settings.order !== 'family') return [{ family: null, items: list }];
  const groups = new Map();
  for (const c of list) {
    const key = (c.family || '').trim() || 'Everyone';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups].map(([family, items]) => ({ family, items }));
}

export async function compileEvent(eventId, progress = () => {}) {
  const ev = getEvent(eventId);
  const groups = orderedContributions(ev);
  const count = groups.reduce((a, g) => a + g.items.length, 0);
  if (!count) throw new Error('There are no finished contributions to compile yet.');
  const outDir = eventDir(eventId, 'output');
  const work = path.join(outDir, 'work');
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });

  const segments = [];
  const manifest = [];
  let t = 0;
  const push = async (file, entry) => {
    const d = await probeDuration(file);
    segments.push(file);
    manifest.push({ ...entry, start: Number(t.toFixed(2)), duration: Number(d.toFixed(2)) });
    t += d;
  };

  progress(0.05, 'Making the title card…');
  const date = new Date(ev.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const intro = path.join(work, 'intro.mp4');
  await cardClip({ title: ev.name, subtitle: ev.settings.dedication || date, out: intro, work, duration: 5, seed: 'intro' });
  await push(intro, { kind: 'title', text: ev.name });

  let done = 0;
  for (const g of groups) {
    if (g.family && groups.length > 1) {
      const card = path.join(work, `family-${segments.length}.mp4`);
      await cardClip({ title: g.family, subtitle: '', out: card, work, duration: 3.2, seed: `fam${segments.length}` });
      await push(card, { kind: 'family', text: g.family });
    }
    for (const c of g.items) {
      await push(eventDir(eventId, 'media', c.id, 'segment.mp4'), {
        kind: c.type,
        id: c.id,
        name: c.name,
        title: c.title || c.autoTitle || '',
        narration: c.type === 'story' ? c.plan.scenes.map((s) => s.narration) : [c.narration || c.caption || c.autoCaption].filter(Boolean),
      });
      done++;
      progress(0.1 + 0.6 * (done / count), `Gathering pieces (${done} of ${count})…`);
    }
  }

  const outro = path.join(work, 'outro.mp4');
  await cardClip({ title: 'Merry Christmas', subtitle: `With love, from all of us · ${date}`, out: outro, work, duration: 6, seed: 'outro' });
  await push(outro, { kind: 'title', text: 'Merry Christmas' });

  progress(0.75, 'Adding music and finishing touches…');
  let music = null;
  if (ev.settings.music === 'silent-night') music = builtInMusic();
  if (ev.settings.music === 'custom' && ev.settings.customMusic) music = eventDir(eventId, 'music', ev.settings.customMusic);
  const final = path.join(outDir, 'keepsake.tmp.mp4');
  const duration = await compileFinal({ segments, out: final, music, musicVolume: ev.settings.musicVolume ?? 0.35, workDir: work });
  await fs.rename(final, path.join(outDir, 'keepsake.mp4'));
  await posterFrame(path.join(outDir, 'keepsake.mp4'), path.join(outDir, 'poster.jpg'), 2.5).catch(() => {});
  await fs.rm(work, { recursive: true, force: true });
  progress(1, 'Done');
  await updateEvent(eventId, (e) => {
    e.compile.output = { file: 'keepsake.mp4', duration, manifest, pieces: count, builtAt: new Date().toISOString(), version: (e.compile.output?.version || 0) + 1 };
  });
  return duration;
}
