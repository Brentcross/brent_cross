import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
process.env.DATA_DIR = dataDir;
process.env.AI_DISABLED = '1';
const { createApp } = await import('../server/app.js');

let server;
let base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const cookieJar = () => {
  let cookies = {};
  const f = async (url, opts = {}) => {
    const res = await fetch(base + url, { ...opts, redirect: 'manual', headers: { ...(opts.headers || {}), cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return res;
  };
  return f;
};
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('host, family and strangers each get the right access', async () => {
  const host = cookieJar();
  const created = await (await host('/api/events', json({ name: 'Test Eve' }))).json();
  assert.ok(created.hostKey && created.inviteUrl);
  assert.equal((await host(`/api/e/${created.id}/state`)).status, 200);

  const stranger = cookieJar();
  assert.equal((await stranger(`/api/e/${created.id}/state`)).status, 403);
  assert.equal((await stranger(`/api/e/${created.id}/mine`)).status, 403);
  assert.equal((await stranger(`/api/e/${created.id}/host-login`, json({ key: 'wrong' }))).status, 403);

  const phone = cookieJar();
  const join = await phone(new URL(created.inviteUrl).pathname);
  assert.equal(join.status, 302);
  assert.equal((await phone(`/api/e/${created.id}/mine`)).status, 200);
  assert.equal((await phone(`/api/e/${created.id}/state`)).status, 403, 'family is not host');

  // A family cookie for one event does not open another event.
  const other = await (await cookieJar()('/api/events', json({ name: 'Other' }))).json();
  assert.equal((await phone(`/api/e/${other.id}/mine`)).status, 403);

  // Wrong invite code
  assert.equal((await stranger(`/join/${created.id}/nope`)).status, 404);
});

test('submissions validate input and are idempotent', async () => {
  const host = cookieJar();
  const ev = await (await host('/api/events', json({ name: 'Eve' }))).json();
  const form = (fields, file) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append('file', new Blob([file]), 'x.bin');
    return { method: 'POST', body: fd };
  };
  const url = `/api/e/${ev.id}/contributions`;
  assert.equal((await host(url, form({ type: 'story', name: '', text: 'hi there' }))).status, 400);
  assert.equal((await host(url, form({ type: 'story', name: 'Bo', text: '' }))).status, 400);
  assert.equal((await host(url, form({ type: 'poem', name: 'Bo', text: 'x' }))).status, 400);
  assert.equal((await host(url, form({ type: 'photo', name: 'Bo' }, Buffer.from('not an image at all')))).status, 415);

  const a = await host(url, form({ type: 'story', name: 'Bo', age: '7', text: 'Santa came!', clientId: 'abc' }));
  assert.equal(a.status, 201);
  const b = await host(url, form({ type: 'story', name: 'Bo', age: '7', text: 'Santa came!', clientId: 'abc' }));
  assert.equal(b.status, 200, 'retry returns the same submission');
  assert.equal((await a.json()).id, (await b.json()).id);

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c60000000049454e44ae426082', 'hex');
  const c = await host(url, form({ type: 'drawing', name: 'Max', age: '4' }, png));
  assert.equal(c.status, 201);
  const state = await (await host(`/api/e/${ev.id}/state`)).json();
  const drawing = state.contributions.find((x) => x.type === 'drawing');
  const orig = Buffer.from(await (await host(`/api/e/${ev.id}/media/${drawing.id}/original`)).arrayBuffer());
  assert.ok(orig.equals(png), 'original stored untouched');
});

test('security headers are set', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
});
