#!/usr/bin/env node
// Tests for star-hunt/store.js (window.StarStore) in Chromium, against a small stand-in for the Firebase
// Realtime Database REST API (PUT / PATCH / DELETE / GET and the live EventSource stream), and in demo mode.
//
//   node tools/store-test.mjs
//
// Each simulated phone is its own browser context on its own 127.0.0.x address. A phone can be put to
// "sleep": its live stream is held back (as when a phone wakes and the user taps before the connection has
// caught up) while its saves and reads still reach the database. That is how the stale-phone cases are tested:
// two phones on one team, a phone waking from sleep, an MC console that hasn't loaded yet, a late save after
// the MC removed a player, and a save that was lost on the way.
//
// Needs `playwright` importable from the repo (symlink a node_modules folder into the repo root) and Chromium:
// CHROMIUM=/path/to/chrome, or the first /opt/pw-browsers/chromium-*/chrome-linux*/chrome.
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEALED = join(ROOT, 'tools/fixtures/sample-hunt.sealed.js');
const PASS = 'test-passphrase';

let failures = 0, passes = 0;
function expect(cond, msg) {
  if (cond) passes++; else failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  return !!cond;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(20); }
  expect(false, 'timed out waiting for ' + what);
  return false;
}

// ---------- the stand-in for Firebase ----------
let db = {};
const listeners = new Set();
const asleep = new Set();     // hosts whose live stream is held back
let dropPatches = 0;          // fail the next n PATCH requests without applying them
let writes = 0;               // PUT/PATCH/DELETE requests seen
const parts = p => p.split('/').filter(Boolean).map(decodeURIComponent);
function clean(v) {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return Date.now();
    const out = Array.isArray(v) && Object.keys(v).every(k => /^\d+$/.test(k)) ? [] : {};
    let any = false;
    for (const k of Object.keys(v)) { const c = clean(v[k]); if (c !== null) { out[k] = c; any = true; } }
    return any ? out : null;
  }
  return v === undefined ? null : v;
}
// Like Firebase: an object whose keys are 0..n-1 (more than half present) comes back as an array.
function asFirebase(v) {
  if (!v || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  const out = {};
  for (const k of keys) out[k] = asFirebase(v[k]);
  if (keys.length && keys.every(k => /^(0|[1-9]\d*)$/.test(k))) {
    const max = Math.max(...keys.map(Number));
    if (keys.length * 2 > max + 1) { const a = []; for (const k of keys) a[+k] = out[k]; return Array.from(a, x => (x === undefined ? null : x)); }
  }
  return out;
}
function getAt(ps) { let n = db; for (const k of ps) { if (!n || typeof n !== 'object') return null; n = n[k]; } return n ?? null; }
function setAt(ps, v) {
  if (!ps.length) { db = clean(v) || {}; return; }
  let n = db;
  for (const k of ps.slice(0, -1)) { if (!n[k] || typeof n[k] !== 'object') n[k] = {}; n = n[k]; }
  const c = clean(v);
  if (c === null) delete n[ps.at(-1)]; else n[ps.at(-1)] = c;
  db = clean(db) || {};
}
function send(l, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (asleep.has(l.host)) l.held.push(msg); else l.res.write(msg);
}
function wake(host) {
  asleep.delete(host);
  for (const l of listeners) if (l.host === host) { for (const m of l.held.splice(0)) l.res.write(m); }
}
function broadcast(ps, kind, body) {
  for (const l of listeners) {
    const under = ps.length >= l.ps.length && l.ps.every((k, i) => ps[i] === k);
    const above = l.ps.length > ps.length && ps.every((k, i) => l.ps[i] === k);
    if (under) {
      const rel = '/' + ps.slice(l.ps.length).join('/');
      if (kind === 'patch') send(l, 'patch', { path: rel, data: body });
      else send(l, 'put', { path: rel, data: asFirebase(getAt(ps)) });
    } else if (above) send(l, 'put', { path: '/', data: asFirebase(getAt(l.ps)) });
  }
}
const fb = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  const ps = parts(new URL(req.url, 'http://x').pathname.replace(/\.json$/, ''));
  const host = (req.headers.host || '').split(':')[0];
  if (req.method === 'GET') {
    if ((req.headers.accept || '').includes('text/event-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const l = { ps, res, host, held: [] };
      listeners.add(l);
      send(l, 'put', { path: '/', data: asFirebase(getAt(ps)) });
      res.on('close', () => listeners.delete(l));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(asFirebase(getAt(ps))));
  }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    writes++;
    const v = body ? JSON.parse(body) : null;
    if (req.method === 'PATCH' && dropPatches > 0) { dropPatches--; res.writeHead(503); return res.end('{"error":"dropped"}'); }
    if (req.method === 'PUT') { setAt(ps, v); broadcast(ps, 'put'); }
    if (req.method === 'DELETE') { setAt(ps, null); broadcast(ps, 'put'); }
    if (req.method === 'PATCH') {
      for (const k of Object.keys(v)) setAt(ps.concat(parts(k)), v[k]);
      const resolved = {};
      for (const k of Object.keys(v)) resolved[k] = asFirebase(getAt(ps.concat(parts(k))));
      broadcast(ps, 'patch', resolved);
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(v));
  });
});

// ---------- the site: the store and its neighbours, with the sealed sample hunt ----------
const sealedText = await readFile(SEALED, 'utf8');
const site = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/star-hunt/blank.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><meta charset="utf-8"><title>store test</title>' +
      ['config.js', 'hunt.sealed.js', 'seal.js', 'store.js'].map(f => `<script src="${f}"></script>`).join(''));
  }
  if (u.pathname === '/star-hunt/hunt.sealed.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(sealedText); }
  try {
    const b = await readFile(join(ROOT, u.pathname));
    res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(b);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => fb.listen(0, '0.0.0.0', r));
await new Promise(r => site.listen(0, '0.0.0.0', r));
const FB_PORT = fb.address().port, SITE_PORT = site.address().port;

let executablePath = process.env.CHROMIUM;
if (!executablePath) {
  const b = '/opt/pw-browsers';
  for (const d of (existsSync(b) ? await readdir(b) : []).filter(d => d.startsWith('chromium-')).sort()) {
    for (const sub of ['chrome-linux', 'chrome-linux64']) if (!executablePath && existsSync(join(b, d, sub, 'chrome'))) executablePath = join(b, d, sub, 'chrome');
  }
}
const { chromium } = await import('playwright');
const browser = await chromium.launch(executablePath ? { executablePath } : {});
let hostN = 1;
// A phone: its own context and address. online: talks to the stand-in; asleepAtLoad: its stream is held from the start.
async function device({ online = true, asleepAtLoad = false } = {}) {
  const ctx = await browser.newContext();
  const host = '127.0.0.' + (++hostN);
  await ctx.route(u => new URL(u).pathname === '/star-hunt/config.js', r => r.fulfill({
    contentType: 'text/javascript',
    body: `window.STAR_HUNT_CONFIG = { firebaseUrl: ${online ? `'http://${host}:${FB_PORT}'` : "''"}, gameId: 'test' };`,
  }));
  const page = await ctx.newPage();
  page.on('pageerror', e => expect(false, `page error on ${host}: ${e.message}`));
  if (asleepAtLoad) asleep.add(host);
  await page.goto(`http://${host}:${SITE_PORT}/star-hunt/blank.html`);
  await page.waitForFunction(() => window.StarStore && window.HuntSeal);
  if (!asleepAtLoad) await page.waitForFunction(() => StarStore.loaded && StarStore.tree);
  page.host = host;
  return page;
}
const sleep = page => asleep.add(page.host);
const wakeUp = page => wake(page.host);
// Run fn(S, H, arg) in the page; errors come back as { error: code }.
const run = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  const f = new Function('return ' + src)();
  try { return await f(window.StarStore, window.HuntSeal, a); } catch (e) { return { error: e.code || e.message }; }
}, [fn.toString(), arg]);
const P = id => (db.games && db.games.test && db.games.test.players && db.games.test.players[id]) || null;
const run0 = v => { const out = []; if (v && typeof v === 'object') for (let i = 0; v[i] != null; i++) out.push(v[i]); return out; };

try {
  // ======================= the whole flow, online and in demo mode =======================
  for (const online of [true, false]) {
    console.log(`\n--- the whole flow: ${online ? 'online (stand-in Firebase)' : 'demo mode (one browser)'} ---`);
    db = {};
    const mc = await device({ online });
    const ph = online ? await device({ online }) : await mc.context().newPage().then(async p => {
      await p.goto(mc.url()); await p.waitForFunction(() => window.StarStore && StarStore.loaded); p.host = mc.host; return p;
    });
    const hunt = await mc.evaluate(p => HuntSeal.openMC(p), PASS);
    const N = hunt.stations.length, codes = hunt.stations.map(s => s.code);
    const ids = await run(ph, async S => {
      const a = await S.addPlayer({ name: 'Ann', pin: '1234' });
      const id = S.uid();
      const b = await S.addPlayer({ id, name: 'Team B', team: true, members: ['X', 'Y'], pin: '9999' });
      return { a, b, same: id === b };
    });
    expect(ids.same, 'addPlayer keeps a given id');
    await mc.waitForFunction(ids => StarStore.player(StarStore.tree, ids.b), ids);
    const pin = await run(mc, async (S, H, ids) => {
      const a = S.player(S.tree, ids.a);
      return [await S.checkPin(a, '1234'), await S.checkPin(a, '1235'), S.player(S.tree, ids.b).members];
    }, ids);
    expect(pin[0] === true && pin[1] === false && isDeepStrictEqual(pin[2], ['X', 'Y']), 'the MC sees both players; checkPin right and wrong; members kept');
    await run(mc, (S, H, ids) => S.setPin(ids.a, '4321'), ids);
    await ph.waitForFunction(async ids => StarStore.checkPin(StarStore.player(StarStore.tree, ids.a), '4321'), ids);
    expect(true, 'setPin works across devices');
    expect(await run(ph, S => !S.started(S.tree) && S.startKey(S.tree) === null), 'not started, no start key');
    await run(mc, (S, H, k) => S.startHunt(k), hunt.startKey);
    await ph.waitForFunction(() => StarStore.started(StarStore.tree));
    const s1 = await run(ph, async (S, H, ids) => {
      const t = S.tree, p = S.player(t, ids.a);
      return { pr: S.progress(p, H.hunt.stationCount), clue: await H.openStart(S.startKey(t)), since: S.clueSince(t, p) === t.meta.startedAt };
    }, ids);
    expect(s1.pr.stage === 'clue' && s1.pr.n === 1 && s1.pr.prevCode === null && s1.clue.clue === hunt.stations[0].clue && s1.since,
      'after Start: clue 1, which opens with meta.startKey; clueSince = startedAt');
    const startedAt1 = await run(mc, S => S.meta(S.tree).startedAt);
    await run(mc, (S, H, k) => S.startHunt(k), hunt.startKey);
    await wait(150);
    expect(await run(mc, S => S.meta(S.tree).startedAt) === startedAt1, 'startHunt again only republishes the key (startedAt stays)');
    // releases
    await run(mc, async (S, H, h) => { await S.releaseFromHunt(h, 1, 'hint1'); await S.releaseFromHunt(h, 1, 'kids'); await S.releaseFromHunt(h, 2, 'open'); await S.release(2, 'hint2', 'custom'); }, hunt);
    expect(/Unknown/.test((await run(mc, S => S.release(1, 'bogus', 'x'))).error), 'release refuses an unknown kind');
    await ph.waitForFunction(() => StarStore.releaseFor(StarStore.tree, 2).hint2 === 'custom');
    const r = await run(ph, S => { const t = S.tree; return { r1: S.releaseFor(t, 1), r2: S.releaseFor(t, 2), r3: S.releaseFor(t, 3), all: S.releases(t).map(x => x.n), opened: S.openedClues(t), last: S.lastReleaseAt(t) }; });
    expect(r.r1.hint1 === hunt.stations[0].hint && r.r1.kids === hunt.stations[0].kids && r.r1.hint1At > 0 && !('hint2' in r.r1) && !('open' in r.r1), 'releaseFor(1): hint1 and kids with their times, nothing else');
    expect(isDeepStrictEqual(r.r2.open, { code: codes[1], hide: hunt.stations[1].hide, title: hunt.stations[1].title }) && r.r2.hint2 === 'custom', 'releaseFor(2): open { code, hide, title } and a custom hint2');
    expect(isDeepStrictEqual(r.r3, {}) && isDeepStrictEqual(r.all, [1, 2]) && r.opened.length === 1 && r.opened[0].n === 2 && r.last > 0, 'releaseFor(3) is {}; releases, openedClues, lastReleaseAt');
    if (online) expect(db.games.test.meta.release.c1 && !Array.isArray(db.games.test.meta.release), 'releases are stored under c1, c2 (an object, not an array)');
    await run(mc, async S => { await S.unrelease(1, 'kids'); await S.unrelease(2); });
    await ph.waitForFunction(() => StarStore.releases(StarStore.tree).length === 1 && !('kids' in StarStore.releaseFor(StarStore.tree, 1)));
    expect(true, 'unrelease(1, kids) and unrelease(2)');
    // play
    const play = await run(ph, async (S, H, [ids, codes, decoy]) => {
      const N = H.hunt.stationCount, me = () => S.player(S.tree, ids.a), out = {};
      out.unknown = S.cardStatus(me(), await H.openCard('ZZZZZZ'));
      const d = await H.openCard(decoy);
      out.decoy = S.cardStatus(me(), d);
      out.decoyFind = (await S.findCard(ids.a, d).catch(e => ({ error: e.code }))).error;
      const e3 = await H.openCard(codes[2]);
      out.notyet = S.cardStatus(me(), e3);
      out.notNext = (await S.findCard(ids.a, e3).catch(e => ({ error: e.code }))).error;
      out.unopened = (await S.findCard(ids.a, codes[3]).catch(e => ({ error: e.code }))).error;
      const e1 = await H.openCard(codes[0]);
      out.notFound = (await S.solveCard(ids.a, e1, N).catch(e => ({ error: e.code }))).error;
      out.next = S.cardStatus(me(), e1);
      await S.findCard(ids.a, e1);
      out.current = S.cardStatus(me(), e1);
      out.stage1 = S.progress(me(), N);
      out.almost = S.cardStatus(me(), await H.openCard(codes[1]));
      await S.solveCard(ids.a, e1, N);
      out.recap = S.cardStatus(me(), e1);
      out.stage2 = S.progress(me(), N);
      out.next2 = S.cardStatus(me(), await H.openCard(codes[1]));
      // the rest with bare codes, as an older page would call it (they are opened, so peekCard knows them)
      for (let i = 1; i < N; i++) {
        await H.openCard(codes[i]);
        await S.findCard(ids.a, codes[i]);
        if (i === N - 1) { await S.setGifts(ids.a, ['a kind word']); await S.addGift(ids.a, 'patience'); }
        await S.solveCard(ids.a, codes[i], N);
      }
      out.done = S.progress(me(), N);
      out.finished = !!me().finishedAt;
      await S.findCard(ids.b, e1);
      return out;
    }, [ids, codes, hunt.decoys[0].code]);
    if (play.error) console.log('   error in the page:', play.error);
    expect(play.unknown === 'unknown' && play.decoy === 'decoy' && play.notyet === 'notyet' && play.next === 'next', 'cardStatus: unknown, decoy, notyet, next');
    expect(play.decoyFind === 'bad-card' && play.notNext === 'not-next' && play.unopened === 'bad-card' && play.notFound === 'not-found',
      'findCard refuses a decoy (bad-card), a later card (not-next) and a code never opened (bad-card); solveCard refuses a card not found');
    expect(play.current === 'current' && play.stage1.stage === 'station' && play.stage1.n === 1 && play.almost === 'almost', 'after findCard: current, at station 1, the next card is "almost"');
    expect(play.recap === 'recap' && play.stage2.stage === 'clue' && play.stage2.n === 2 && play.stage2.prevCode === codes[0] && play.next2 === 'next', 'after solveCard: recap, clue 2 with prevCode = card 1, card 2 is next');
    expect(play.done.stage === 'done' && play.done.written === N && play.finished, 'every station solved (bare codes work too): done, finishedAt set');
    await mc.waitForFunction(([id, n]) => { const p = StarStore.player(StarStore.tree, id); return p && p.finishedAt && p.gifts.length === 2; }, [ids.a, N]);
    const board = await run(mc, (S, H, ids) => {
      const t = S.tree;
      return { order: S.standings(t).map(p => p.name), placeA: S.place(t, ids.a), placeB: S.place(t, ids.b), fin: S.finishers(t).map(p => p.name), lw: S.latestWrite(t), gifts: S.allGifts(t), progB: S.progress(S.player(t, ids.b), H.hunt.stationCount) };
    }, ids);
    expect(isDeepStrictEqual(board.order, ['Ann', 'Team B']) && board.placeA === 1 && board.placeB === 2 && isDeepStrictEqual(board.fin, ['Ann']), 'standings, place, finishers on the MC device');
    expect(board.lw && board.lw.player.name === 'Ann' && board.lw.n === N, 'latestWrite: Ann wrote the last phrase');
    expect(isDeepStrictEqual(board.gifts.map(g => g.text + '/' + g.name), ['a kind word/Ann', 'patience/Ann']), 'allGifts (setGifts, then addGift)');
    expect(board.progB.stage === 'station' && board.progB.n === 1, 'Team B is at station 1');
    if (online) {
      const a = P(ids.a);
      expect(isDeepStrictEqual(asFirebase(a.found), codes) && isDeepStrictEqual(asFirebase(a.solved), codes), 'the database holds found and solved in station order (as lists)');
    }
    await run(mc, S => S.clearProgress());
    await ph.waitForFunction(() => !StarStore.started(StarStore.tree));
    const cleared = await run(ph, S => { const t = S.tree; return { key: S.startKey(t), rel: S.releases(t).length, players: S.players(t).map(p => [p.found.length, p.solved.length, p.gifts.length, !!p.finishedAt, !!p.pinHash]) }; });
    expect(!cleared.key && !cleared.rel && cleared.players.length === 2 && cleared.players.every(p => !p[0] && !p[1] && !p[2] && !p[3] && p[4]),
      'clearProgress: not started, key withdrawn, releases gone, players kept with their PINs and no progress');
    await run(mc, (S, H, ids) => S.removePlayer(ids.b), ids);
    await ph.waitForFunction(() => StarStore.players(StarStore.tree).length === 1);
    expect(true, 'removePlayer');
    await run(mc, S => S.newGame());
    await ph.waitForFunction(() => StarStore.players(StarStore.tree).length === 0 && !StarStore.tree.meta);
    expect(!online || !db.games || !db.games.test, 'newGame removes every player and meta');
    await mc.context().close(); if (online) await ph.context().close();
  }

  // ======================= stale phones (online) =======================
  console.log('\n--- two phones on one team; a phone waking from sleep ---');
  db = {};
  const mc = await device(), A = await device(), B = await device();
  const hunt = await mc.evaluate(p => HuntSeal.openMC(p), PASS);
  const N = hunt.stations.length, codes = hunt.stations.map(s => s.code);
  await run(mc, (S, H, k) => S.startHunt(k), hunt.startKey);
  const id = await run(A, S => S.addPlayer({ name: 'The Wise Men', team: true, members: ['Ann', 'Ben'], pin: '1111' }));
  await B.waitForFunction(id => StarStore.player(StarStore.tree, id), id);
  // Both phones play: A finds and solves card 1.
  const step = (page, kind, i) => run(page, async (S, H, [id, code, kind, N]) => { const e = await H.openCard(code); return kind === 'find' ? S.findCard(id, e) : S.solveCard(id, e, N); }, [id, codes[i], kind, N]);
  await step(A, 'find', 0); await step(A, 'solve', 0);
  await B.waitForFunction(id => StarStore.player(StarStore.tree, id).solved.length === 1, id);
  sleep(B);                                         // B's phone sleeps at clue 2
  await step(A, 'find', 1); await step(A, 'solve', 1); await step(A, 'find', 2);
  await until(() => run0(P(id) && P(id).found).length === 3, 'A to find card 3');
  const clueAt2 = P(id).clueAt;
  // B wakes on its old copy (clue 2) and the user scans card 2 before the stream catches up.
  const bSees = await run(B, async (S, H, [id, code]) => S.cardStatus(S.player(S.tree, id), await H.openCard(code)), [id, codes[1]]);
  expect(bSees === 'next', 'the sleeping phone still thinks card 2 is next');
  await step(B, 'find', 1);
  await wait(100);
  expect(isDeepStrictEqual(run0(P(id).found), codes.slice(0, 3)) && isDeepStrictEqual(run0(P(id).solved), codes.slice(0, 2)),
    'its findCard on the old copy erases nothing: the database still has 3 found and 2 solved');
  // ...and does station 2's task again before catching up.
  await step(B, 'solve', 1);
  await wait(100);
  expect(isDeepStrictEqual(run0(P(id).solved), codes.slice(0, 2)) && P(id).clueAt === clueAt2 && !P(id).finishedAt,
    'its solveCard on the old copy changes nothing either: clueAt stays (standings unchanged)');
  expect(await run(A, (S, H, [id, N]) => S.progress(S.player(S.tree, id), N), [id, N]).then(p => p.stage === 'station' && p.n === 3),
    'the other phone is still at station 3 (not bounced back)');
  wakeUp(B);
  await B.waitForFunction(([id, N]) => { const p = StarStore.progress(StarStore.player(StarStore.tree, id), N); return p.stage === 'station' && p.n === 3; }, [id, N]);
  expect(true, 'once awake, the phone catches up to station 3');
  // The finish: A solves the last station while B sleeps at it; B finishes it later on its old copy.
  await step(A, 'solve', 2); await step(A, 'find', 3);
  await B.waitForFunction(id => StarStore.player(StarStore.tree, id).found.length === 4, id);
  sleep(B);
  await step(A, 'solve', 3);
  await until(() => P(id).finishedAt, 'A to finish');
  const fin = { finishedAt: P(id).finishedAt, clueAt: P(id).clueAt };
  await wait(30);
  await step(B, 'solve', 3);
  await wait(100);
  expect(P(id).finishedAt === fin.finishedAt && P(id).clueAt === fin.clueAt, 'a late finish from the sleeping phone keeps the first finish time');
  wakeUp(B);
  await B.waitForFunction(([id, N]) => StarStore.progress(StarStore.player(StarStore.tree, id), N).stage === 'done', [id, N]);
  const w0 = writes;
  await step(B, 'solve', 3);
  await wait(100);
  expect(writes === w0, 'solving again on an up-to-date phone writes nothing');
  // Two phones add gifts at the same moment.
  await Promise.all([run(A, (S, H, id) => S.addGift(id, 'love'), id), run(B, (S, H, id) => S.addGift(id, 'time'), id)]);
  await A.waitForFunction(id => StarStore.player(StarStore.tree, id).gifts.length === 2, id);
  expect(isDeepStrictEqual((await run(A, (S, H, id) => S.player(S.tree, id).gifts, id)).sort(), ['love', 'time']), 'addGift from two phones at once keeps both gifts');

  console.log('\n--- an MC console that has not loaded yet, or is behind ---');
  const mc2 = await device({ asleepAtLoad: true });
  const startedAt = db.games.test.meta.startedAt;
  const early = await run(mc2, async (S, H, [k, id]) => ({
    loaded: S.loaded, tree: S.tree,
    start: (await S.startHunt(k).catch(e => ({ error: e.code }))).error,
    clear: (await S.clearProgress().catch(e => ({ error: e.code }))).error,
    find: (await S.findCard(id, 'X').catch(e => ({ error: e.code }))).error,
    solve: (await S.solveCard(id, 'X', 4).catch(e => ({ error: e.code }))).error,
    gifts: (await S.setGifts(id, ['x']).catch(e => ({ error: e.code }))).error,
    pin: (await S.setPin(id, '2222').catch(e => ({ error: e.code }))).error,
  }), [hunt.startKey, id]);
  expect(early.loaded === false && early.tree === null, 'before its stream has loaded: S.loaded is false and S.tree is null');
  expect(['start', 'clear', 'find', 'solve', 'gifts', 'pin'].every(k => early[k] === 'not-loaded'), 'startHunt, clearProgress, findCard, solveCard, setGifts and setPin refuse with "not-loaded"');
  expect(db.games.test.meta.startedAt === startedAt, 'so a console that has not loaded cannot reset the race clock');
  wakeUp(mc2);
  await mc2.waitForFunction(() => StarStore.loaded);
  await run(mc, S => S.clearProgress());
  await mc2.waitForFunction(() => !StarStore.started(StarStore.tree));
  sleep(mc2);                                        // the second console falls behind...
  await run(mc, (S, H, k) => S.startHunt(k), hunt.startKey);
  await until(() => db.games.test.meta && db.games.test.meta.startedAt, 'the start');
  const s2 = db.games.test.meta.startedAt;
  await wait(30);
  expect(await run(mc2, S => S.started(S.tree)) === false, 'the console that is behind still shows "not started"');
  await run(mc2, (S, H, k) => S.startHunt(k), hunt.startKey);   // ...and its Start is pressed
  await wait(100);
  expect(db.games.test.meta.startedAt === s2, 'its Start only republishes the key: startedAt stays');
  wakeUp(mc2);

  console.log('\n--- a removed player, a lost save, a stray slot ---');
  const gid = await run(A, S => S.addPlayer({ name: 'Gone Soon', pin: '3333' }));
  await B.waitForFunction(id => StarStore.player(StarStore.tree, id), gid);
  await run(B, (S, H, [gid, code]) => H.openCard(code).then(e => S.findCard(gid, e)), [gid, codes[0]]);
  await until(() => P(gid) && run0(P(gid).found).length === 1, 'Gone Soon to find card 1');
  sleep(B);
  await run(mc, (S, H, gid) => S.removePlayer(gid), gid);
  await until(() => !P(gid), 'the removal');
  await run(B, (S, H, gid) => S.setGifts(gid, ['late gift']), gid);        // a late save from the removed player's phone
  await run(B, (S, H, [gid, code, N]) => H.openCard(code).then(e => S.solveCard(gid, e, N)), [gid, codes[0], N]);
  await until(() => P(gid), 'the late save to land');
  const ghost = await run(mc, (S, H, gid) => ({ listed: !!S.player(S.tree, gid), names: S.players(S.tree).map(p => p.name), ghosts: S.ghostIds(S.tree) }), gid);
  expect(!ghost.listed && ghost.names.every(Boolean) && isDeepStrictEqual(ghost.ghosts, [gid]), 'a late save makes a leftover record, which players() skips and ghostIds() lists');
  expect(!P(gid).solved && !P(gid).clueAt, 'a late solveCard asks the server first and does not write to a removed player');
  const refusals = await run(mc, async (S, H, gid) => ({
    gifts: (await S.setGifts(gid, ['x']).catch(e => ({ error: e.code }))).error,
    pin: (await S.setPin(gid, '1234').catch(e => ({ error: e.code }))).error,
  }), gid);
  expect(refusals.gifts === 'no-player' && refusals.pin === 'no-player', 'setGifts and setPin refuse a player who is not in the game ("no-player")');
  await run(mc, S => S.removeGhosts());
  await until(() => !P(gid), 'removeGhosts');
  expect(!P(gid), 'removeGhosts deletes the leftover record');
  wakeUp(B);
  // clearProgress also removes leftovers.
  await B.waitForFunction(gid => !StarStore.tree.players || !StarStore.tree.players[gid], gid);
  const g2 = await run(A, S => S.addPlayer({ name: 'Also Gone', pin: '4444' }));
  await until(() => P(g2), 'Also Gone');
  // a leftover, written the way a late save would write it
  await run(A, (S, H, g2) => S.removePlayer(g2), g2);
  await until(() => !P(g2), 'the removal');
  await run(A, (S, H, g2) => S.update('players/' + g2, { lastAt: S.SERVER_TIME }), g2);
  await until(() => P(g2), 'the leftover');
  await run(mc, S => S.clearProgress());
  await until(() => !P(g2), 'clearProgress');
  expect(!P(g2) && P(id) && !P(id).found, 'clearProgress removes leftovers and clears the real players');
  await run(mc, (S, H, k) => S.startHunt(k), hunt.startKey);
  await A.waitForFunction(() => StarStore.started(StarStore.tree));
  // A lost save: the database drops card 1's save; the next save mends it.
  dropPatches = 1;
  const errs = await run(A, async (S, H, [id, code]) => {
    let n = 0; window.addEventListener('star-store-error', () => n++);
    await S.findCard(id, await H.openCard(code));
    return n;
  }, [id, codes[0]]);
  expect(errs === 1 && !P(id).found, 'a dropped save raises star-store-error and leaves the database without card 1');
  await step(A, 'solve', 0);
  await until(() => P(id).solved, 'the solve');
  expect(isDeepStrictEqual(run0(P(id).found), codes.slice(0, 1)) && isDeepStrictEqual(run0(P(id).solved), codes.slice(0, 1)) && P(id).clueAt > 0,
    'the next save (solveCard) mends it: found and solved both hold card 1');
  // A stray slot (a late save after "clear progress") is ignored until the run reaches it.
  await run(mc, (S, H, [id, code]) => S.update('players/' + id, { 'found/3': code }), [id, codes[3]]);
  await A.waitForFunction(id => StarStore.tree.players[id].found && (StarStore.tree.players[id].found[3] || StarStore.tree.players[id].found['3']), id);
  const stray = await run(A, (S, H, [id, N]) => ({ found: S.player(S.tree, id).found, prog: S.progress(S.player(S.tree, id), N) }), [id, N]);
  expect(isDeepStrictEqual(stray.found, codes.slice(0, 1)) && stray.prog.stage === 'clue' && stray.prog.n === 2, 'a stray slot (station 4) is ignored: still on clue 2');
} finally {
  await browser.close();
  fb.close(); site.close();
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${passes} checks passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
