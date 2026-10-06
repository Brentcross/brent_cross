// A small JSON-file store: one directory per event holding event.json plus the
// uploaded originals and rendered media. Writes are serialized per event and
// atomic (write temp file, then rename) so a crash never leaves a torn file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const eventsDir = path.join(config.dataDir, 'events');
fs.mkdirSync(eventsDir, { recursive: true, mode: 0o700 });

const cache = new Map(); // id -> event object
const writing = new Map(); // id -> promise chain
const listeners = new Set();

export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function eventDir(id, ...parts) {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) throw new Error('bad event id');
  return path.join(eventsDir, id, ...parts);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function load(id) {
  if (cache.has(id)) return cache.get(id);
  let file;
  try {
    file = eventDir(id, 'event.json');
  } catch {
    return null;
  }
  if (!fs.existsSync(file)) return null;
  const ev = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(id, ev);
  return ev;
}

export function getEvent(id) {
  return load(id);
}

export function allEvents() {
  return fs
    .readdirSync(eventsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => load(d.name))
    .filter(Boolean);
}

function persist(ev) {
  const id = ev.id;
  const prev = writing.get(id) || Promise.resolve();
  const next = prev.then(async () => {
    const file = eventDir(id, 'event.json');
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(ev, null, 1), { mode: 0o600 });
    await fsp.rename(tmp, file);
  });
  writing.set(id, next.catch((e) => console.error('[store] write failed', e)));
  return next;
}

export async function createEvent({ name, hostKey }) {
  const id = newId(9);
  fs.mkdirSync(eventDir(id, 'media'), { recursive: true, mode: 0o700 });
  const ev = {
    id,
    name: name || 'Our Christmas Eve',
    createdAt: new Date().toISOString(),
    hostKeyHash: sha256(hostKey),
    familyCode: newId(12),
    shareToken: newId(18),
    seq: 0,
    settings: {
      order: 'submitted', // or 'family'
      music: 'silent-night', // 'none' | 'custom'
      musicVolume: 0.35,
      dedication: '',
      requireReview: false, // when true every piece waits for host approval
    },
    contributions: [],
    compile: { status: 'idle' },
  };
  cache.set(id, ev);
  await persist(ev);
  return ev;
}

// Mutate an event through a function; changes are persisted and broadcast.
export async function updateEvent(id, fn) {
  const ev = load(id);
  if (!ev) throw new Error('event not found');
  const result = await fn(ev);
  ev.updatedAt = new Date().toISOString();
  await persist(ev);
  for (const l of listeners) {
    try {
      l(ev);
    } catch {}
  }
  return result;
}

export function getContribution(ev, cid) {
  return ev.contributions.find((c) => c.id === cid);
}

export async function updateContribution(eventId, cid, patch) {
  return updateEvent(eventId, (ev) => {
    const c = getContribution(ev, cid);
    if (!c) return null;
    Object.assign(c, typeof patch === 'function' ? patch(c) || {} : patch);
    return c;
  });
}

export async function flush() {
  await Promise.all(writing.values());
}
