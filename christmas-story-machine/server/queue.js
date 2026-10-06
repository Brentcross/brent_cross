// In-process job queue with two stages:
//   words  – Claude writes captions / plans stories (network-bound, AI_CONCURRENCY)
//   render – ffmpeg makes the segment (CPU-bound, RENDER_CONCURRENCY)
// Submissions are accepted instantly and flow through both stages in the
// background, so a burst of uploads never overwhelms the machine and the final
// compile only has to stitch finished segments together. State lives in the
// event file, so a restart resumes where it left off.
import { config } from './config.js';
import { allEvents, getEvent, updateContribution, updateEvent } from './store.js';
import { compileEvent, renderContribution, writeWords } from './pipeline.js';

const MAX_ATTEMPTS = 3;

function pool(concurrency, handler) {
  const pending = [];
  const queued = new Set();
  let running = 0;
  const pump = () => {
    while (running < concurrency && pending.length) {
      const job = pending.shift();
      running++;
      handler(job).finally(() => {
        running--;
        queued.delete(job.key);
        pump();
      });
    }
  };
  return {
    add(eventId, cid) {
      const key = `${eventId}/${cid}`;
      if (queued.has(key)) return;
      queued.add(key);
      pending.push({ eventId, cid, key });
      pump();
    },
    stats: () => ({ waiting: pending.length, running }),
  };
}

async function attempt(stage, { eventId, cid }, fn) {
  const c = getEvent(eventId)?.contributions.find((x) => x.id === cid);
  if (!c) return false;
  const attempts = (c.attempts || 0) + 1;
  await updateContribution(eventId, cid, { attempts });
  try {
    await fn(eventId, cid);
    await updateContribution(eventId, cid, { attempts: 0 });
    return true;
  } catch (err) {
    console.error(`[${stage}] ${eventId}/${cid} attempt ${attempts} failed:`, err);
    if (attempts < MAX_ATTEMPTS) {
      await updateContribution(eventId, cid, { status: 'queued', statusDetail: 'Retrying…' });
      setTimeout(() => (stage === 'words' ? words : render).add(eventId, cid), 2000 * attempts);
    } else {
      await updateContribution(eventId, cid, { status: 'failed', statusDetail: 'Could not be processed', error: String(err.message || err).slice(0, 300) });
    }
    return false;
  }
}

const render = pool(config.renderConcurrency, (job) => attempt('render', job, renderContribution));
const words = pool(config.aiConcurrency, async (job) => {
  if (await attempt('words', job, writeWords)) render.add(job.eventId, job.cid);
});

export const enqueue = (eventId, cid) => words.add(eventId, cid);

export function queueStats() {
  const w = words.stats();
  const r = render.stats();
  return { waiting: w.waiting + r.waiting, running: w.running + r.running, words: w, render: r };
}

// Requeue anything that was mid-flight when the server stopped.
export function resumeAll() {
  for (const ev of allEvents()) {
    for (const c of ev.contributions) {
      if (['queued', 'writing', 'rendering', 'received'].includes(c.status)) enqueue(ev.id, c.id);
    }
    if (ev.compile?.status === 'running') {
      updateEvent(ev.id, (e) => {
        e.compile.status = 'idle';
        e.compile.message = 'Interrupted by a restart; press Compile again.';
      });
    }
  }
}

// ------------------------------------------------------------------ compilation (one at a time per event)
const compiling = new Set();
export async function startCompile(eventId) {
  if (compiling.has(eventId)) return false;
  compiling.add(eventId);
  await updateEvent(eventId, (e) => {
    e.compile = { ...e.compile, status: 'running', progress: 0, message: 'Starting…', startedAt: new Date().toISOString(), error: null };
  });
  let last = 0;
  const progress = (p, message) => {
    const now = Date.now();
    if (p < 1 && now - last < 400) return;
    last = now;
    updateEvent(eventId, (e) => {
      e.compile.progress = p;
      e.compile.message = message;
    });
  };
  compileEvent(eventId, progress)
    .then(() =>
      updateEvent(eventId, (e) => {
        e.compile.status = 'done';
        e.compile.finishedAt = new Date().toISOString();
        e.compile.message = 'Your keepsake is ready!';
      }),
    )
    .catch((err) => {
      console.error('[compile]', err);
      return updateEvent(eventId, (e) => {
        e.compile.status = 'failed';
        e.compile.error = String(err.message || err).slice(0, 300);
        e.compile.message = 'Something went wrong while compiling.';
      });
    })
    .finally(() => compiling.delete(eventId));
  return true;
}
