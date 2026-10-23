#!/usr/bin/env node
// End-to-end test of For Unto Us (star-hunt/), the whole race on the REAL sealed hunt.
//
//   python3 -m http.server 8080 --bind 127.0.0.1 --directory .     (from the repo root, in another terminal)
//   STAR_HUNT_PASSPHRASE=... node tools/star-hunt-test.mjs [screenshotDir]
//
// Environment:
//   STAR_HUNT_PASSPHRASE  required: the MC passphrase. The test unseals star-hunt/hunt.sealed.js with it to
//                         learn the codes, riddles and answers, and types it into mc.html and print.html.
//   URL                   where the repo root is served (default http://127.0.0.1:8080/). It must be on 127.0.0.1:
//                         the pages need a secure context for crypto.subtle, and nothing here is for the network.
//   CHROMIUM              path to Chromium (default: Playwright's, or the first /opt/pw-browsers/chromium-*).
// Needs `playwright`, `jsqr` and `pngjs` importable from the repo (symlink a node_modules folder into the repo
// root while testing; never commit it), plus pdfinfo/pdftoppm (poppler) for the printed-PDF check.
//
// Safety: config.js is always routed to a local stand-in for the Firebase Realtime Database REST API that this
// script runs in memory on 127.0.0.1 (or to demo mode), any request to *.firebaseio.com is aborted, and any
// request to anything but the served site and the stand-in is aborted and counted as a failure. The family's
// real database is never touched.
//
// Every screen runs in its own browser context, like separate devices (each has its own connection pool, so the
// 6-connections-per-host limit never bites), and talks to the stand-in database under its own path prefix
// (http://127.0.0.1:<port>/dev-<n>), so the stand-in knows which device is asking and can fail one device's live
// stream. Buttons are clicked by role and accessible name; text is read from the page without scripts.
//
// What it covers: every served file is free of secrets; MC passphrase unlock (wrong, then right); the TV join
// screen; three players and teams on separate phones (a duplicate name is refused); a card scanned before the
// start; MC Start (clue 1 on every phone); an out-of-order card (refused without a spoiler); a Herod decoy; recap
// on rescan; one team playing all the stations, with every task type (a wrong word is refused and pointed at the
// verse it comes from) and every painting's credit line; the MC releasing Hint 1, Hint 2, Little ones and Open on
// a clue another team is stuck on (each shows on that phone live, and only then; a player who reaches the clue
// later sees them too); the TV's standings, opened clue and hint log (never the hint text); sign-in on another
// phone (wrong PIN, then right); an MC PIN reset; the first finisher and the gifts on the TV; the finale; the
// print page (every printed QR decodes to its card link, the answer key has the setup notes); MC clear progress
// and new game; weak Wi-Fi (a phone's save that the database refuses for a while is retried and lands once it
// recovers; the TV recovers when its live stream drops and is answered once with 503); the MC's pause, early end and
// reveal (a paused TV sign and a clock that stands still, phones that refuse a card or a task while paused and take
// them after Resume, an early end that names the leader, phones and the TV refusing progress after it, the reveal
// stepped through on the TV's keyboard from 4th up to 1st to the final top 4, the places on a phone after the TV,
// and Reopen); and demo mode in one browser. At every step the phones' DOM is checked for text they have not earned yet: a later riddle, a station
// not yet found, a hint, little-ones line or hiding spot the MC has not released, and anything MC-only (answers,
// solutions, setup notes, decoys).
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import * as T from './seal-hunt.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = (process.env.URL || 'http://127.0.0.1:8080/').replace(/\/?$/, '/');
if (new URL(SITE).hostname !== '127.0.0.1') {
  console.error(`URL must be served on 127.0.0.1 (python3 -m http.server <port> --bind 127.0.0.1), not ${SITE}`);
  process.exit(2);
}
const BASE = SITE + 'star-hunt/';
const PAGES_URL = 'https://brentcross.github.io/brent_cross/star-hunt/';   // what QR codes point at when served locally
const GAME = 'for-unto-us-2026';
const ME_KEY = 'star-hunt:me:' + GAME;
const OUT = resolve(process.argv[2] || join(tmpdir(), 'star-hunt-test'));
mkdirSync(OUT, { recursive: true });

let failures = 0, checks = 0;
function expect(cond, msg) {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  return !!cond;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- the hunt: unsealed with the MC passphrase ----------
const PASS = process.env.STAR_HUNT_PASSPHRASE || '';
if (!PASS.trim()) {
  console.error('Set STAR_HUNT_PASSPHRASE to the MC passphrase: this test unseals star-hunt/hunt.sealed.js to know the codes and answers.');
  process.exit(2);
}
const SEALED = T.parseSealedJs(readFileSync(join(ROOT, 'star-hunt/hunt.sealed.js'), 'utf8'));
const MC_COPY = await T.openMC(SEALED, PASS);
if (!MC_COPY) {
  console.error('STAR_HUNT_PASSPHRASE does not open star-hunt/hunt.sealed.js.');
  process.exit(2);
}
const H = MC_COPY.hunt;
const ST = H.stations;
const NST = ST.length;
const DECOYS = H.decoys || [];
// The readable copy (hunt-private/hunt.json) is checked too when it exists: an edit not yet sealed must not leak either.
const PRIVATE_PATH = join(ROOT, 'hunt-private/hunt.json');
const PRIVATE = existsSync(PRIVATE_PATH) ? JSON.parse(readFileSync(PRIVATE_PATH, 'utf8')) : null;

// Text as a reader sees it: typographic quotes and runs of white space don't matter.
const N = s => String(s == null ? '' : s).replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  .replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
// A word-task prompt draws its "____" as a blank: compare the longest written part.
const promptPart = p => N(String(p || '').split(/_{3,}/).sort((a, b) => b.length - a.length)[0]);
// The credit line under a painting as the phone shows it. A credit that starts with the painting's title again
// ("Title (Bible Videos) · Courtesy of …") loses it, because the work line above already names the painting; a
// clean one ("Bible Videos · Courtesy of …") shows as it is.
function creditLine(art) {
  let c = N(art && art.credit);
  const title = N(art && art.title);
  if (title && c.startsWith(title)) c = c.slice(title.length).trim().replace(/^\(([^()]*)\)/, '$1').replace(/^[\s,·–—-]+/, '');
  return c;
}
// The scripture a word task quotes its blank from: the first reference after the blank ("… thy ____ …" (Genesis 28:14)).
const REF = /(?:[1-4] )?[A-Z][a-z]+ \d+:\d+(?:[–-]\d+)?/;
const refAfterBlank = prompt => { const m = String(prompt || '').split(/_{3,}/).slice(1).join(' ').match(REF); return m ? m[0] : null; };

// Every secret, keyed "<field>:<station n>" so a screen can be allowed what it has earned.
const SECRETS = [];
function addSecret(key, text, what) {
  const n = N(text);
  if (n.length >= 4 && !SECRETS.some(s => s.key === key && s.norm === n)) SECRETS.push({ key, norm: n, what });
}
for (const hunt of [H, PRIVATE].filter(Boolean)) {
  hunt.stations.forEach((s, i) => {
    const k = i + 1;
    addSecret('code:' + k, s.code, `station ${k} code`);
    addSecret('clue:' + k, s.clue, `riddle ${k}`);
    addSecret('title:' + k, s.title, `station ${k} title`);
    addSecret('story:' + k, s.story, `station ${k} story`);
    addSecret('ponder:' + k, s.ponder, `station ${k} ponder line`);
    if (s.challenge) addSecret('prompt:' + k, promptPart(s.challenge.prompt), `station ${k} task prompt`);
    addSecret('hint:' + k, s.hint, `hint 1 for clue ${k}`);
    addSecret('hint2:' + k, s.hint2, `hint 2 for clue ${k}`);
    addSecret('kids:' + k, s.kids, `little-ones line for clue ${k}`);
    addSecret('hide:' + k, s.hide, `hiding spot ${k}`);
    addSecret('answer:' + k, s.answer, `answer ${k}`);
    addSecret('solution:' + k, s.solution, `solution ${k}`);
    addSecret('setup:' + k, s.setup, `setup note ${k}`);
  });
  (hunt.decoys || []).forEach((d, i) => { addSecret('decoy', d.code, `decoy ${i + 1} code`); addSecret('decoy', d.hide, `decoy ${i + 1} hiding spot`); });
  if (hunt.finale) { addSecret('finale', hunt.finale.text, 'finale text'); addSecret('finale', hunt.finale.heading, 'finale heading'); }
}
const ALL_CODES = ST.map(s => s.code).concat(DECOYS.map(d => d.code));

// ---------- stand-in for the Firebase Realtime Database (REST + EventSource) ----------
let db = {};
const listeners = new Set();
const parts = p => p.split('/').filter(Boolean).map(decodeURIComponent);
function clean(v) {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return Date.now();
    const out = Array.isArray(v) ? [] : {};
    let any = false;
    for (const k of Object.keys(v)) { const c = clean(v[k]); if (c !== null) { out[k] = c; any = true; } }
    return any ? out : null;
  }
  return v === undefined ? null : v;
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
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
function broadcast(ps, kind, body) {
  for (const l of listeners) {
    const under = ps.length >= l.ps.length && l.ps.every((k, i) => ps[i] === k);
    const above = l.ps.length > ps.length && ps.every((k, i) => l.ps[i] === k);
    if (under) {
      const rel = '/' + ps.slice(l.ps.length).join('/');
      if (kind === 'patch') send(l.res, 'patch', { path: rel, data: body });
      else send(l.res, 'put', { path: rel, data: getAt(ps) });
    } else if (above) send(l.res, 'put', { path: '/', data: getAt(l.ps) });
  }
}
// Weak Wi-Fi: while `net.refuseWrites` is on, every write is answered 503 (and counted in `net.refused`); a device
// in `net.failStreams` has its next live stream(s) answered 503 (counted in `net.failedStreams`).
const net = { refuseWrites: false, refused: 0, failStreams: new Map(), failedStreams: 0 };
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  const ps = parts(new URL(req.url, 'http://x').pathname.replace(/\.json$/, ''));
  const dev = /^dev-\d+$/.test(ps[0] || '') ? ps.shift() : '';   // which device is asking (see newContext)
  if (req.method === 'GET') {
    if ((req.headers.accept || '').includes('text/event-stream')) {
      if (net.failStreams.get(dev) > 0) {
        net.failStreams.set(dev, net.failStreams.get(dev) - 1);
        net.failedStreams++;
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.end('Service Unavailable');
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const l = { ps, res, dev };
      listeners.add(l);
      send(res, 'put', { path: '/', data: getAt(ps) });
      res.on('close', () => listeners.delete(l));
      return;
    }
    return res.end(JSON.stringify(getAt(ps)));
  }
  if (net.refuseWrites) {
    net.refused++;
    req.resume();
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Service Unavailable' }));
  }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const v = body ? JSON.parse(body) : null;
    if (req.method === 'PUT') { setAt(ps, v); broadcast(ps, 'put'); }
    if (req.method === 'DELETE') { setAt(ps, null); broadcast(ps, 'put'); }
    if (req.method === 'PATCH') {
      for (const k of Object.keys(v)) setAt(ps.concat(parts(k)), v[k]);
      const resolved = {};
      for (const k of Object.keys(v)) resolved[k] = getAt(ps.concat(parts(k)));
      broadcast(ps, 'patch', resolved);
    }
    res.end(JSON.stringify(v));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));   // this machine only
const DB_PORT = server.address().port;
const game = () => getAt(['games', GAME]) || {};
// A change made straight in the database (as another device's save would arrive).
function dbPut(ps, v) { setAt(ps, v); broadcast(ps, 'put'); }
// The connection drops (a router roaming, a phone sleeping): end every live stream of one device.
function dropStreams(dev) { for (const l of [...listeners]) if (l.dev === dev) l.res.end(); }
const run = v => { const out = []; if (v && typeof v === 'object') for (let i = 0; v[i] != null; i++) out.push(v[i]); return out; };

// ---------- browser and devices ----------
function chromePath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  try { return execSync('ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1').toString().trim() || undefined; } catch { return undefined; }
}
const exe = chromePath();
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const firebaseHits = [], outsideHits = [];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const SIZES = { phone: PHONE, tv: { viewport: { width: 1920, height: 1080 } }, mc: { viewport: { width: 1440, height: 900 } }, print: { viewport: { width: 1100, height: 900 } } };
let devN = 0;
// The only places a screen may reach: the served site and the stand-in database, both on 127.0.0.1.
const SITE_ORIGIN = new URL(SITE).origin, DB_ORIGIN = 'http://127.0.0.1:' + DB_PORT;
const local = href => href.startsWith(SITE_ORIGIN + '/') || href.startsWith(DB_ORIGIN + '/') || /^(data|blob|about):/.test(href);

async function newContext(kind, online) {
  const ctx = await browser.newContext(SIZES[kind]);
  ctx.dev = 'dev-' + (++devN);
  await ctx.route(u => !local(u.href), r => {
    const url = r.request().url();
    (/firebaseio\.com|firebasedatabase\.app/.test(url) ? firebaseHits : outsideHits).push(url);
    return r.abort();
  });
  await ctx.route(u => /\/star-hunt\/config\.js/.test(u.pathname), r => r.fulfill({
    contentType: 'text/javascript',
    body: `window.STAR_HUNT_CONFIG = { firebaseUrl: ${online ? `'${DB_ORIGIN}/${ctx.dev}'` : "''"}, gameId: '${GAME}' };`,
  }));
  return ctx;
}
function watch(page, name) {
  page.devName = name;
  page.answers = [];   // queued replies for confirm()/prompt(): true/'text' accepts, false/null dismisses
  page.on('pageerror', e => { console.log(`pageerror (${name}): ${e.message}`); failures++; });
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) console.log(`console.error (${name}): ${m.text()}`); });
  page.on('dialog', d => {
    const a = page.answers.shift();
    if (a === undefined) { console.log(`unexpected dialog (${name}): ${d.message().split('\n')[0]}`); failures++; return d.dismiss(); }
    return a === false || a === null ? d.dismiss() : d.accept(typeof a === 'string' ? a : undefined);
  });
  return page;
}
async function device(name, kind = 'phone', path = 'index.html') {
  const ctx = await newContext(kind, true);
  const page = watch(await ctx.newPage(), name);
  page.ctx = ctx;
  if (path != null) await page.goto(BASE + path);
  return page;
}

// ---------- reading pages ----------
const NORM_SRC = `s => String(s).replace(/[\\u201C\\u201D]/g, '"').replace(/[\\u2018\\u2019]/g, "'").replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim()`;
// Visible text: the body without scripts, styles and hidden elements.
const VISIBLE = `() => { const b = document.body.cloneNode(true); b.querySelectorAll('script, style, [hidden]').forEach(e => e.remove()); return (${NORM_SRC})(b.textContent); }`;
// Everything in the DOM a curious player could read: all text (hidden too) and every attribute value.
const EVERYTHING = `() => { const b = document.documentElement.cloneNode(true); b.querySelectorAll('script, style').forEach(e => e.remove());
  const attrs = []; b.querySelectorAll('*').forEach(el => { for (const a of el.attributes) attrs.push(a.value); });
  return (${NORM_SRC})(b.textContent + ' \\n ' + attrs.join(' \\n ')); }`;
// The TV: the view on screen (the others are faded out).
const TV_VIEW = `() => { const v = [...document.querySelectorAll('.tv-view')].find(x => !x.classList.contains('is-off')); return v ? v.id : ''; }`;
const TV_TEXT = `() => { const v = [...document.querySelectorAll('.tv-view')].find(x => !x.classList.contains('is-off')); return v ? (${NORM_SRC})(v.textContent) : ''; }`;
// (page.evaluate runs a string as an expression, so call the function source.)
const txt = page => page.evaluate(`(${VISIBLE})()`);
const everything = page => page.evaluate(`(${EVERYTHING})()`);
async function until(page, text, ms = 8000, src = VISIBLE) {
  try { await page.waitForFunction(([t, f]) => (0, eval)('(' + f + ')')().includes(t), [N(text), src], { timeout: ms, polling: 100 }); return true; }
  catch { return false; }
}
async function gone(page, text, ms = 8000) {
  try { await page.waitForFunction(([t, f]) => !(0, eval)('(' + f + ')')().includes(t), [N(text), VISIBLE], { timeout: ms, polling: 100 }); return true; }
  catch { return false; }
}
const untilTv = (page, text, ms = 8000) => until(page, text, ms, TV_TEXT);
async function tvShows(page, view, ms = 8000) {
  try { await page.waitForFunction(([v, f]) => (0, eval)('(' + f + ')')() === v, ['v-' + view, TV_VIEW], { timeout: ms, polling: 100 }); return true; }
  catch { return false; }
}
async function imagesLoaded(page) {
  await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 8000 }).catch(() => {});
}
async function shot(page, name, { full = false, top = true } = {}) {
  if (top) await page.evaluate(() => window.scrollTo(0, 0));
  await imagesLoaded(page);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await sleep(700);   // the quiet fade-in
  await page.screenshot({ path: join(OUT, name + '.png'), fullPage: full });
}

// ---------- what a phone may show ----------
// From the game state: riddles up to the clue the player has reached; title, story, ponder line, task and code of
// the stations they have found; and for those clues only what the MC has released. Never answers, solutions,
// setup notes or decoys; the finale only at the end.
function allowedFor(id) {
  const t = game(), p = id && t.players && t.players[id];
  const ok = new Set();
  if (!p || !(t.meta && t.meta.startedAt)) return ok;
  const found = run(p.found), solved = run(p.solved);
  const maxClue = solved.length >= NST ? NST : solved.length + 1;
  for (let k = 1; k <= maxClue; k++) ok.add('clue:' + k);
  for (let k = 1; k <= found.length; k++) for (const f of ['title', 'story', 'ponder', 'prompt', 'code']) ok.add(f + ':' + k);
  if (solved.length >= NST) ok.add('finale');
  const rel = (t.meta && t.meta.release) || {};
  for (let k = 1; k <= maxClue; k++) {
    const r = rel['c' + k] || {};
    if (r.hint1) ok.add('hint:' + k);
    if (r.hint2) ok.add('hint2:' + k);
    if (r.kids) ok.add('kids:' + k);
    if (r.open) for (const f of ['hide', 'code', 'title']) ok.add(f + ':' + k);
  }
  return ok;
}
async function phoneLeaks(page) {
  const id = await page.evaluate(k => { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch { return null; } }, ME_KEY);
  const ok = allowedFor(id);
  const dom = await everything(page);
  return SECRETS.filter(s => !ok.has(s.key) && dom.includes(s.norm)).map(s => s.what);
}
async function phoneSecretsOk(page, label) {
  const leaks = await phoneLeaks(page);
  return expect(!leaks.length, `${label}: nothing unearned or unreleased in the ${page.devName} phone's DOM` + (leaks.length ? ` (found ${[...new Set(leaks)].join('; ')})` : ''));
}
// The TV: only opened clues' code, hiding spot and title; never a riddle, hint, little-ones line or anything MC-only.
async function tvSecretsOk(page, label) {
  const rel = (game().meta && game().meta.release) || {};
  const ok = new Set();
  for (let k = 1; k <= NST; k++) if (rel['c' + k] && rel['c' + k].open) for (const f of ['hide', 'code', 'title']) ok.add(f + ':' + k);
  const dom = await everything(page);
  const leaks = SECRETS.filter(s => !ok.has(s.key) && dom.includes(s.norm)).map(s => s.what);
  return expect(!leaks.length, `${label}: the TV shows no secret beyond the opened clues` + (leaks.length ? ` (found ${[...new Set(leaks)].join('; ')})` : ''));
}

// ---------- player actions (real buttons by role and name) ----------
async function register(page, { name, pin, members }) {
  const team = members != null;
  await page.getByRole('button', { name: team ? 'Make a team' : 'Play solo', exact: true }).click();
  await page.getByLabel(team ? 'Team name' : 'Your name').fill(name);
  if (team) await page.getByLabel('Who’s on the team?').fill(members);
  await page.getByLabel(/Choose a 4-digit PIN/).fill(pin);
  await page.getByRole('button', { name: team ? 'Make our team' : 'Join the hunt', exact: true }).click();
}
async function typeCode(page, code) {
  await page.getByRole('textbox', { name: 'Card code' }).fill(code);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
}
const scan = (page, code) => page.evaluate(c => { location.hash = 's=' + c; }, code);   // what a camera link does on an open page
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function signIn(page, name, pin) {
  await page.getByRole('button', { name: new RegExp('^' + esc(name)) }).click();
  await page.getByLabel('PIN', { exact: true }).fill(pin);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
}
const GIFTS = { W: ['Serve my neighbors this winter', 'Read the Book of Mormon with Grandpa'], B: ['Help Mom with dinner every Sunday'], C: ['Write to a missionary'] };
async function solveTask(page, k, { wrongFirst = false, gifts = ['Be kind to my little brother'], label }) {
  const c = ST[k].challenge;
  if (!c) return;
  if (c.type === 'together') {
    await page.getByRole('button', { name: c.button || 'We did it', exact: true }).click();
    expect(await until(page, 'Thank you.'), `${label}: together task done ("${c.button}")`);
  } else if (c.type === 'word') {
    const field = page.getByRole('textbox', { name: 'Your answer' });
    if (wrongFirst) {
      const plain = w => String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
      const wrong = ['everything', 'something', 'anything'].find(w => !c.answers.some(a => plain(a) === w));
      await field.fill(wrong);
      await page.getByRole('button', { name: 'Check', exact: true }).click();
      // Refused: the field is marked wrong and the station stays open. The note under it (its description) points
      // to where the word is: the verse the blank is quoted from when the prompt names it, else the scriptures shown.
      await page.waitForFunction(() => { const f = document.querySelector('[aria-label="Your answer"]'); return f && f.getAttribute('aria-invalid') === 'true'; }, null, { timeout: 5000 }).catch(() => {});
      const note = N(await field.evaluate(f => (f.getAttribute('aria-describedby') || '').split(/\s+/).map(id => { const d = document.getElementById(id); return d ? d.textContent : ''; }).join(' ')));
      const next = page.getByRole('button', { name: /^(Show the next clue|Finish)$/ }).first();
      expect(await field.getAttribute('aria-invalid') === 'true' && await field.isEditable() && await next.isDisabled() && !!note && !/^Yes\b/.test(note),
        `${label}: a wrong word is refused ("${note}")`);
      const ref = refAfterBlank(c.prompt), refs = (ST[k].scriptures || []).map(x => N(x.ref));
      expect(ref ? note.includes(N(ref)) : (/scripture/i.test(note) || refs.some(r => note.includes(r))),
        `${label}: the refusal points to ${ref ? `${ref}, the verse the blank is quoted from` : 'the scriptures on the station'}`);
    }
    await field.fill(c.answers[0].toUpperCase() + '!');   // case and punctuation don't matter
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    expect(await until(page, 'Yes.'), `${label}: word task answered`);
  } else if (c.type === 'order') {
    if (wrongFirst) {
      await page.getByRole('button', { name: c.items[1], exact: true }).click();
      expect(await until(page, 'Not that one yet. Look at the scripture above.'), `${label}: a tile out of order is refused`);
    }
    for (const item of c.items) await page.getByRole('button', { name: item, exact: true }).click();
    expect(await until(page, 'That’s it.'), `${label}: order task done`);
  } else if (c.type === 'gifts') {
    const done = page.getByRole('button', { name: 'We’ve added our gifts', exact: true });
    expect(await done.isDisabled(), `${label}: "We’ve added our gifts" waits for a gift`);
    for (const g of gifts) {
      await page.getByRole('textbox', { name: 'Your gift' }).fill(g);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      expect(await until(page, g), `${label}: gift "${g}" listed`);
    }
    await done.click();
    expect(await until(page, 'He will treasure them.'), `${label}: gifts task done`);
  }
}
// Station k (0-based) from its clue: enter the card, check the station, do the task, go on.
async function playStation(page, k, { via = 'type', label, wrongFirst = false, gifts, before, after, quick = false } = {}) {
  const s = ST[k], n = k + 1, last = n === NST;
  label = label || `${page.devName} station ${n}`;
  if (!quick) {
    expect(await until(page, s.clue), `${label}: clue ${n}'s riddle is on screen`);
    await phoneSecretsOk(page, `${label} (clue ${n})`);
  }
  if (via === 'type') await typeCode(page, s.code);
  else if (via === 'scan') await scan(page, s.code);
  else if (via === 'use') await page.getByRole('button', { name: 'Use this code', exact: true }).click();
  else if (via === 'messy') await typeCode(page, ' ' + s.code.slice(0, 3).toLowerCase() + '-' + s.code.slice(3).toLowerCase() + ' ');
  expect(await until(page, s.title), `${label}: "${s.title}" opens (${via})`);
  if (!quick) {
    const text = await txt(page);
    expect(text.includes(N(s.phrase)) && text.includes('Added to your verse') && text.includes('Station ' + n), `${label}: the phrase "${s.phrase}" is written into the verse`);
    if (s.art) {
      await imagesLoaded(page);
      const art = await page.evaluate(() => { const i = document.querySelector('.plate img'); return i ? { w: i.naturalWidth, portrait: !!document.querySelector('.plate--portrait') } : null; });
      const credit = N(await page.evaluate(() => { const c = document.querySelector('.object-label .credit'); return c ? c.textContent : ''; }));
      expect(!!art && art.w > 0 && credit === creditLine(s.art) && !!credit && !credit.startsWith(N(s.art.title)),
        `${label}: the painting loads with its credit line ("${credit}")`);
    }
    if (!last) expect(!text.includes(N(ST[k + 1].clue)), `${label}: the next riddle stays hidden until the task is done`);
    if (s.challenge) expect(await page.getByRole('button', { name: last ? 'Finish' : 'Show the next clue', exact: true }).isDisabled(), `${label}: the next button waits for the task`);
    await phoneSecretsOk(page, `${label} (at the station)`);
  }
  if (before) await before();
  await solveTask(page, k, { wrongFirst, gifts, label });
  if (after) await after();
  await page.getByRole('button', { name: last ? 'Finish' : 'Show the next clue', exact: true }).click();
  if (!last) expect(await until(page, ST[k + 1].clue), `${label}: clue ${n + 1}'s riddle appears after the task`);
  else expect(await until(page, 'You finished'), `${label}: the finished screen`);
}

// A phone that sat on a station while a teammate's phone did the task holds that station (it says so) until
// someone taps on: tap through and wait for the text.
async function catchUp(page, text) {
  for (let i = 0; i < 4; i++) {
    if (await until(page, text, 2500)) return true;
    const next = page.getByRole('button', { name: /^(Show the next clue|Finish)$/ });
    if (await next.count() && await next.first().isEnabled()) await next.first().click();
  }
  return until(page, text, 2500);
}

// ---------- the MC console ----------
async function mcRelease(mc, n, kind) {
  const names = { hint1: `Release hint 1 for clue ${n}`, hint2: `Release hint 2 for clue ${n}`, kids: `Release the little-ones clue for clue ${n}`, open: `Open clue ${n}` };
  const yes = kind === 'open' ? `Open clue ${n}` : 'Release';
  await mc.getByRole('button', { name: names[kind], exact: true }).click();
  await mc.locator(`#clue-${n} .mc-confirm`).getByRole('button', { name: yes, exact: true }).click();
  // The console's own copy of the game has it at once (the phones are checked separately).
  try { await mc.waitForFunction(([n, k]) => StarStore.releaseFor(StarStore.tree, n)[k] != null, [n, kind], { timeout: 5000 }); return true; }
  catch { return false; }
}

// =====================================================================================================
async function servedFilesCheck() {
  console.log('\n=== Served files: no secret anywhere ===');
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]);
  const rel = f => relative(ROOT, f).split(sep).join('/');
  // Everything the deploy workflow publishes: the star-hunt folder plus the root app files.
  const files = walk(join(ROOT, 'star-hunt')).map(rel);
  for (const f of ['index.html', 'manifest.webmanifest', 'sw.js']) if (existsSync(join(ROOT, f))) files.push(f);
  if (existsSync(join(ROOT, 'icons'))) files.push(...walk(join(ROOT, 'icons')).map(rel));
  // A file leaks a secret when its text, read as is or with HTML entities and JavaScript escapes undone, holds it.
  const unhtml = s => s.replace(/&(amp|quot|#39|#x27|apos|lt|gt|nbsp|rsquo|lsquo|ldquo|rdquo);/g, (m, e) =>
    ({ amp: '&', quot: '"', '#39': "'", '#x27': "'", apos: "'", lt: '<', gt: '>', nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' })[e]);
  const unjs = s => s.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\[nrt]/g, ' ').replace(/\\(["'\\/])/g, '$1');
  const leaksIn = buf => {
    const raw = buf.toString('latin1'), text = buf.toString('utf8');
    const hay = [N(text), N(unjs(unhtml(text)))].join('\n');
    return SECRETS.filter(s => hay.includes(s.norm) || (s.norm.length <= 16 && raw.includes(s.norm))).map(s => s.what);
  };
  // The check itself must work: a hint written into a page (escaped) or a script (JSON) is caught.
  const esc = t => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  expect(leaksIn(Buffer.from('<p title="x">' + esc(ST[NST - 1].hint2) + '</p>')).length > 0 &&
    leaksIn(Buffer.from('var x = ' + JSON.stringify({ k: ST[3].clue }) + ';')).length > 0 &&
    leaksIn(Buffer.from('\xff\xd8' + DECOYS[0].code + '\x00', 'latin1')).length > 0 &&
    leaksIn(Buffer.from('<p>' + esc(SEALED.intro) + '</p>')).length === 0, 'the served-file check catches a planted hint, riddle and code (and passes public text)');
  let bytes = 0, bad = 0;
  for (const f of files) {
    const r = await fetch(SITE + f.split('/').map(encodeURIComponent).join('/'));
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok) { expect(false, `served: ${f} (HTTP ${r.status})`); continue; }
    bytes += buf.length;
    const leaks = leaksIn(buf);
    if (leaks.length) { bad++; expect(false, `served file ${f} contains ${[...new Set(leaks)].join('; ')}`); }
  }
  expect(files.length > 30 && bad === 0, `all ${files.length} served files (${Math.round(bytes / 1024)} KB, fetched over HTTP) are free of codes, hiding spots, answers, solutions, hints, little-ones lines, setup notes, riddles, station titles, stories, ponder lines, task prompts and the finale`);
  // The readable copy is never published.
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  if (tracked.status === 0) {
    const list = tracked.stdout.split('\n').filter(Boolean);
    expect(!list.some(f => f.startsWith('hunt-private/')), 'hunt-private/ is not tracked by git');
    let leaky = [];
    for (const f of list) {
      if (!existsSync(join(ROOT, f))) continue;
      const text = readFileSync(join(ROOT, f));
      const hay = N(text.toString('utf8')), raw = text.toString('latin1');
      // The public sample hunt happens to share one generic three-word station title with the real hunt;
      // titles are only checked outside it.
      const hits = SECRETS.filter(s => !(s.key.startsWith('title:') && f.startsWith('tools/fixtures/')) &&
        (hay.includes(s.norm) || (s.norm.length <= 16 && raw.includes(s.norm))));
      if (hits.length) leaky.push(f + ': ' + [...new Set(hits.map(s => s.what))].join('; '));
    }
    expect(!leaky.length, `no secret in any of the ${list.length} files tracked by git` + (leaky.length ? ': ' + leaky.join(' | ') : ''));
  }
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  expect(/^hunt-private\/?$/m.test(ignore), '.gitignore lists hunt-private/');
  const pub = SEALED;
  expect(Array.isArray(pub.notYet) && pub.notYet.length && !pub.notYet.some(l => /^\s*not yet\b/i.test(l)), 'no "not yet" line repeats the "Not yet" label the phone already shows');
}

// =====================================================================================================
async function onlineRace() {
  console.log('\n=== The race, online (stand-in Firebase), on separate devices ===');
  // ----- MC console: passphrase gate -----
  const mc = await device('MC', 'mc', 'mc.html');
  await mc.getByLabel('MC passphrase').fill('wrong horse battery staple');
  await mc.getByRole('button', { name: 'Go', exact: true }).click();
  expect(await until(mc, 'That passphrase doesn’t open this hunt'), 'MC: a wrong passphrase is refused');
  expect(!(await everything(mc)).includes(N(ST[0].clue)) && !(await everything(mc)).includes(ST[0].code), 'MC: nothing of the hunt is on the page while locked');
  await mc.getByLabel('MC passphrase').fill(PASS);
  await mc.getByRole('button', { name: 'Go', exact: true }).click();
  expect(await until(mc, 'Ready when you are', 15000), 'MC: the passphrase unlocks the console');
  expect(await mc.getByRole('button', { name: 'Start the hunt', exact: true }).isVisible(), 'MC: Start button');
  expect(!(await mc.content()).includes(PASS), 'MC: the passphrase is never written into the page');

  // ----- TV: join screen -----
  const tv = await device('TV', 'tv', 'tv.html');
  expect(await tvShows(tv, 'waiting'), 'TV: the join screen shows before the start');
  expect(await untilTv(tv, 'Scan to join') && await untilTv(tv, 'Nobody yet. Scan the code to be first.'), 'TV: "Scan to join", nobody yet');
  {
    const png = PNG.sync.read(await tv.locator('#v-waiting .qr').screenshot());
    const q = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(q && q.data === PAGES_URL, 'TV: the join QR opens the hosted player app (' + (q && q.data) + ')');
  }

  // ----- players sign up on their own phones -----
  const W = await device('Wise Men');
  expect(await until(W, 'Who’s playing?'), 'phone: welcome asks who is playing');
  if (SEALED.cover && SEALED.cover.credit) {
    await imagesLoaded(W);
    const credit = N(await W.evaluate(() => { const c = document.querySelector('.cover-credit .credit'); return c ? c.textContent : ''; }));
    expect(credit === creditLine(SEALED.cover) && !!credit && !credit.startsWith(N(SEALED.cover.title)), `welcome: the cover painting's credit line ("${credit}")`);
  }
  await phoneSecretsOk(W, 'welcome');
  // The DOM check itself must work: a hidden element or an attribute holding a secret is caught.
  await W.evaluate(([t, c]) => { const x = document.createElement('span'); x.id = 'planted'; x.hidden = true; x.dataset.c = c; x.textContent = t; document.body.append(x); },
    [ST[NST - 1].hint2.replace(/"/g, '\u201C'), DECOYS[1].code]);
  const planted = await phoneLeaks(W);
  await W.evaluate(() => document.getElementById('planted').remove());
  expect(planted.length >= 2, 'the phone DOM check catches a planted hidden hint and a code in an attribute (' + planted.join('; ') + ')');
  await register(W, { name: 'The Wise Men', pin: '1111', members: 'Caspar, Melchior, Balthazar' });
  expect(await until(W, 'You’re in'), 'team "The Wise Men" registers and waits');
  const B = await device('Mom & Ellie');
  await register(B, { name: 'Mom & Ellie', pin: '2222', members: 'Megan, Ellie' });
  expect(await until(B, 'You’re in'), 'team "Mom & Ellie" registers on another phone');
  const C = await device('Ryan');
  await register(C, { name: 'Ryan', pin: '3333' });
  expect(await until(C, 'You’re in'), 'solo player "Ryan" registers on a third phone');
  expect(await until(W, '3 players have joined'), 'waiting screens count everyone, live');
  const D = await device('Second phone');
  expect(await until(D, '3 joined') && await until(D, 'The Wise Men') && await until(D, 'Mom & Ellie'), 'a fourth phone sees the roster');
  await shot(D, 'phone-01-welcome');
  await register(D, { name: '  ryan ', pin: '4444' });
  expect(await until(D, 'Someone already has that name. Try another.'), 'a duplicate name is refused (case and spaces ignored)');
  await D.getByRole('button', { name: 'Back' }).first().click();
  expect(await until(D, 'Who’s playing?'), 'Back returns to the roster');
  await shot(W, 'phone-02-waiting');
  expect(await untilTv(tv, '3 joined') && await untilTv(tv, 'Mom & Ellie') && await untilTv(tv, 'The Wise Men') && await untilTv(tv, 'Ryan'), 'TV: everyone who joined is listed');
  await shot(tv, 'tv-01-waiting');
  expect(await until(mc, 'Mom & Ellie') && await until(mc, 'The Wise Men') && await until(mc, '3 joined'), 'MC: everyone who joined is listed');

  // ----- a card before the start -----
  await scan(C, ST[0].code);
  expect(await until(C, 'The hunt hasn’t started yet'), 'a card scanned before the start is refused');
  await C.getByRole('button', { name: 'OK', exact: true }).click();
  expect(await until(C, 'You’re in'), 'OK returns to waiting');
  for (const p of [W, B, C]) await phoneSecretsOk(p, 'before the start');

  // ----- MC Start: clue 1 on every phone at once -----
  mc.answers.push(true);
  await mc.getByRole('button', { name: 'Start the hunt', exact: true }).click();
  for (const p of [W, B, C]) expect(await until(p, ST[0].clue), `Start: clue 1 appears on ${p.devName}'s phone`);
  expect(await until(W, 'Clue 1 of ' + NST), `"Clue 1 of ${NST}"`);
  expect(game().meta.startKey === MC_COPY.startKey, 'Start publishes the start key that opens clue 1');
  expect(!(await txt(W)).toLowerCase().includes('hint'), 'no hint button or hint text on the phone before a release');
  expect(await tvShows(tv, 'race'), 'TV switches to the race');
  for (const p of [W, B, C]) await phoneSecretsOk(p, 'clue 1');
  await tvSecretsOk(tv, 'race start');

  // ----- an out-of-order card and a decoy -----
  await scan(C, ST[4].code);
  expect(await until(C, 'Not yet'), 'a later card: "Not yet"');
  {
    const t = await txt(C);
    expect(SEALED.notYet.some(l => t.includes(N(l))), 'a gentle "not yet" line is shown');
    expect(!t.includes(N(ST[4].title)) && !t.includes(N(ST[4].phrase)), 'the later station stays hidden (no title, no phrase)');
  }
  await phoneSecretsOk(C, 'not-yet message');
  await C.getByRole('button', { name: 'Back to your clue' }).last().click();
  expect(await until(C, ST[0].clue), 'back to clue 1');
  await scan(C, DECOYS[0].code);
  expect(await until(C, 'Herod’s decoy') && await until(C, SEALED.decoyMessage.title), 'a decoy card shows Herod’s message');
  await phoneSecretsOk(C, 'decoy message');
  await C.getByRole('button', { name: 'Back to your clue' }).last().click();

  // ----- The Wise Men play stations 1 to 4 -----
  await playStation(W, 0, { via: 'messy', before: () => shot(W, 'phone-04-station-1-art') });
  await playStation(W, 1, {
    wrongFirst: true,
    before: async () => {
      await shot(W, 'phone-05-station-2-art');
      await shot(W, 'phone-05-station-2-art-full', { full: true });
      await scan(W, ST[2].code);   // the next card, before this task is done
      expect(await until(W, 'Finish this station first') && await until(W, ST[1].title), '"Almost": finish this station first (names the current station only)');
      await phoneSecretsOk(W, 'almost message');
      await W.getByRole('button', { name: 'Back to your station' }).last().click();
      expect(await until(W, ST[1].challenge.prompt.split('____')[0].slice(0, 40)), 'back to the station');
    },
  });
  await scan(W, ST[0].code);   // an earlier card again
  expect(await until(W, 'Already in your verse') && await until(W, 'Station 1 · already found') && await until(W, ST[0].title), 'recap on rescanning an earlier card');
  expect(!(await txt(W)).includes(N(ST[0].challenge.button)), 'the recap has no task');
  await W.getByRole('button', { name: 'Back to your clue' }).last().click();
  await playStation(W, 2);
  await playStation(W, 3, { via: 'scan' });
  expect(await until(W, `Clue 5 of ${NST}`), 'The Wise Men are on clue 5');

  // ----- Mom & Ellie do station 1 and get stuck on clue 2 -----
  await playStation(B, 0);
  expect(await until(B, `Clue 2 of ${NST}`), 'Mom & Ellie are on clue 2');
  expect(await untilTv(tv, 'Clue 2') && await untilTv(tv, 'Clue 5'), 'TV standings show where each team is');
  await mc.locator('#clue-2 > summary').click();
  expect(await until(mc, '1 here') && await until(mc, 'Release hint 1'), 'MC: clue 2 opens with who is on it and what can be released');

  // ----- the MC releases help for clue 2, one at a time -----
  const s2 = ST[1];
  const help = [['hint1', 'hint', 'Hint 1'], ['hint2', 'hint2', 'Hint 2'], ['kids', 'kids', 'Little ones']];
  for (const [kind, field, name] of help) {
    expect(!(await everything(B)).includes(N(s2[field])), `${name} for clue 2 is not on the stuck phone before the MC releases it`);
    expect(await mcRelease(mc, 2, kind), `MC: ${name} for clue 2 released`);
    expect(await until(B, s2[field]), `${name} appears live on the stuck phone`);
    for (const p of [C, W]) expect(!(await everything(p)).includes(N(s2[field])), `${name} for clue 2 does not show on ${p.devName} (on another clue)`);
    await tvSecretsOk(tv, `after ${name}`);
  }
  expect(!(await everything(B)).includes(N(s2.hide)) && !(await everything(B)).includes(s2.code), 'the hiding spot and code are not on the stuck phone before Open');
  expect(await mcRelease(mc, 2, 'open'), 'MC: clue 2 opened');
  expect(await until(B, 'Opened by the MC') && await until(B, s2.hide) && await until(B, s2.code), 'Open: hiding spot and code appear live on the stuck phone');
  for (const p of [C, W]) expect(!(await everything(p)).includes(N(s2.hide)), `the opened hiding spot does not show on ${p.devName}`);
  for (const p of [B, C, W]) await phoneSecretsOk(p, 'after the clue 2 releases');
  await shot(B, 'phone-03-clue-with-released-hints');
  await shot(B, 'phone-03-clue-with-released-hints-full', { full: true });
  // TV: standings, the opened clue, and the hint log without the hint text.
  expect(await untilTv(tv, 'Clues opened by the MC') && await untilTv(tv, s2.hide) && await untilTv(tv, s2.code) && await untilTv(tv, s2.title), 'TV: the opened clue shows its title, hiding spot and code');
  const log = await tv.evaluate(() => [...document.querySelectorAll('#r-opened .tv-log li .what')].map(li => li.textContent.replace(/\s+/g, ' ').trim()));
  expect(log.length >= 1 && log.every(l => /^Clue 2 · (Hint 1|Hint 2|Little ones clue) released$/.test(l)), 'TV: the hint log says which clue and which kind only: ' + JSON.stringify(log));
  await tvSecretsOk(tv, 'race with clue 2 opened');
  const standings = N(await tv.evaluate(() => document.getElementById('r-standings').textContent));
  expect(['The Wise Men', 'Mom & Ellie', 'Ryan'].every(n => standings.includes(n)) && standings.indexOf('The Wise Men') < standings.indexOf('Mom & Ellie') && standings.indexOf('Mom & Ellie') < standings.indexOf('Ryan'), 'TV: standings in race order');
  expect(await untilTv(tv, 'Just written') && await untilTv(tv, 'Mom & Ellie wrote'), 'TV: "Just written" names the latest writer');
  await shot(tv, 'tv-02-race');
  // MC: the clue's answer fold has the riddle, answer, solution and the setup note.
  await mc.getByText('Riddle, answer, solution and setup').first().click();
  expect(await until(mc, s2.setup) && await until(mc, s2.answer) && await until(mc, s2.clue), 'MC: the answer fold shows the riddle, answer, solution and setup note');
  expect(await until(mc, 'Opened') && await until(mc, 'Released'), 'MC: the clue shows what was released');
  await mc.evaluate(() => window.scrollTo(0, document.getElementById('clue-2').getBoundingClientRect().top + window.scrollY - 24));
  await shot(mc, 'mc-01-running-clue-open', { top: false });
  await shot(mc, 'mc-01-running-clue-open-full', { full: true });
  await mc.evaluate(() => window.scrollTo(0, 0));

  // ----- Ryan signs in on another phone -----
  await signIn(D, 'Ryan', '9999');
  expect(await until(D, 'That PIN isn’t right.'), 'another phone: a wrong PIN is refused');
  await phoneSecretsOk(D, 'PIN screen');
  await D.getByLabel('PIN', { exact: true }).fill('3333');
  await D.getByRole('button', { name: 'Go', exact: true }).click();
  expect(await until(D, ST[0].clue) && await until(D, 'Clue 1 of'), 'the right PIN picks up Ryan’s game on the second phone');

  // ----- MC resets Mom & Ellie's PIN -----
  await mc.getByRole('button', { name: 'Reset PIN for Mom & Ellie', exact: true }).click();
  await mc.getByLabel(/New 4-digit PIN for/).fill('4321');
  await mc.getByRole('button', { name: 'Save PIN', exact: true }).click();
  expect(await until(mc, 'new PIN is 4321'), 'MC: PIN reset saved and shown to the MC');
  await mc.getByRole('button', { name: 'Done', exact: true }).click();
  await B.getByRole('button', { name: 'Not you? Switch player' }).click();
  expect(await until(B, 'Who’s playing?'), 'Switch player returns to the roster');
  await signIn(B, 'Mom & Ellie', '2222');
  expect(await until(B, 'That PIN isn’t right.'), 'the old PIN no longer works');
  await B.getByLabel('PIN', { exact: true }).fill('4321');
  await B.getByRole('button', { name: 'Go', exact: true }).click();
  expect(await until(B, s2.clue) && await until(B, 'Opened by the MC') && await until(B, s2.hint), 'the new PIN signs back in, progress and releases kept');

  // ----- Mom & Ellie use the opened code; Ryan reaches clue 2 later and sees everything released -----
  await playStation(B, 1, { via: 'use' });
  await playStation(C, 0, { via: 'type' });
  for (const [, field, name] of help) expect(await until(C, s2[field]), `${name} for clue 2 shows for a player who arrives later`);
  expect(await until(C, 'Opened by the MC') && await until(C, s2.code), 'the opened clue shows for a player who arrives later');
  // The idle second phone either follows straight to clue 2 or, if it was showing station 1 when the first
  // phone did the task, says so and waits for one tap.
  expect(await catchUp(D, s2.hint), 'Ryan’s second phone follows along (at most one tap)');
  await playStation(C, 1, { via: 'use' });

  // ----- The Wise Men finish: stations 5 to the end -----
  {
    // A camera opens the card link in a new tab of a signed-in phone.
    const tab = watch(await W.ctx.newPage(), 'Wise Men (camera tab)');
    expect(await until(W, ST[4].clue), 'Wise Men: clue 5');
    await tab.goto(BASE + 'index.html#s=' + ST[4].code);
    expect(await until(tab, ST[4].title), 'camera link in a new tab opens the next station');
    // Let its save land before the tab goes away (closing a tab cancels a request still on the wire).
    const wId = await W.evaluate(k => localStorage.getItem(k), ME_KEY);
    for (let i = 0; i < 100 && !run((game().players || {})[wId] && game().players[wId].found).includes(ST[4].code); i++) await sleep(50);
    await tab.close();
    expect(await until(W, ST[4].title), 'the first tab follows to station 5');
    await solveTask(W, 4, { wrongFirst: true, label: 'Wise Men station 5' });
    await W.getByRole('button', { name: 'Show the next clue', exact: true }).click();
  }
  for (let k = 5; k < NST; k++) await playStation(W, k, { gifts: GIFTS.W });
  expect(await until(W, 'You finished 1st') && await until(W, H.finale.heading) && await until(W, 'Your gifts for Him') && await until(W, `${NST} of ${NST}`), 'The Wise Men finish 1st: finale, whole verse and gifts');
  expect(await until(W, 'Written by The Wise Men'), 'the finished verse is credited to the team');
  await phoneSecretsOk(W, 'finished');
  await shot(W, 'phone-06-finished');
  await shot(W, 'phone-06-finished-full', { full: true });
  expect(await until(tv, 'At the manger', 8000, `() => (${NORM_SRC})(document.getElementById('r-news').textContent)`) &&
    await until(tv, 'The Wise Men', 8000, `() => (${NORM_SRC})(document.getElementById('r-news').textContent)`), 'TV: the first finisher is at the manger');
  expect(N(await tv.evaluate(() => document.getElementById('r-standings').textContent)).includes('1st to finish'), 'TV: the standings say "1st to finish"');
  const giftsTv = await device('TV (gifts)', 'tv', 'tv.html?view=gifts');
  expect(await tvShows(giftsTv, 'gifts') && await untilTv(giftsTv, 'They presented unto him gifts') && await untilTv(giftsTv, GIFTS.W[0]) && await untilTv(giftsTv, GIFTS.W[1]), 'TV: the gifts wall shows the gifts for Him');
  await shot(giftsTv, 'tv-04-gifts');
  await giftsTv.ctx.close();

  // ----- everyone else finishes -----
  for (let k = 2; k < NST; k++) await playStation(B, k, { quick: true, gifts: GIFTS.B });
  expect(await until(B, 'You finished 2nd'), 'Mom & Ellie finish 2nd');
  for (let k = 2; k < NST; k++) await playStation(C, k, { quick: true, gifts: GIFTS.C });
  expect(await until(C, 'You finished 3rd'), 'Ryan finishes 3rd');
  // Ryan's second phone sat on a station while the first phone did the tasks: it says so and waits for a tap.
  expect(await until(D, 'Your team finished this on another phone.'), 'the idle second phone says the task was done on another phone');
  expect(await catchUp(D, 'You finished 3rd'), 'one tap and the second phone catches up: finished 3rd');
  for (const p of [B, C, D]) await phoneSecretsOk(p, 'finished');
  expect(await tvShows(tv, 'finale', 10000), 'TV: when everyone is home it shows the whole verse');
  {
    const t = await tv.evaluate(`(${TV_TEXT})()`);
    const phrases = ST.map(s => N(s.phrase));
    expect(phrases.every(p => t.includes(p)), 'TV finale: every phrase of the verse');
    expect(t.includes('The Wise Men') && t.indexOf('The Wise Men') < t.indexOf('Mom & Ellie') && t.indexOf('Mom & Ellie') < t.indexOf('Ryan'), 'TV finale: the places at the manger');
  }
  await tvSecretsOk(tv, 'finale');
  await shot(tv, 'tv-03-finale');

  return { mc, tv, W, B, C, D };
}

// =====================================================================================================
async function printCheck() {
  console.log('\n=== Print page ===');
  const ctx = await newContext('print', false);
  const page = watch(await ctx.newPage(), 'print');
  await page.goto(BASE + 'print.html');
  expect(await page.isVisible('#gate-h') && !(await page.isVisible('#printer')), 'print: locked behind the passphrase');
  {
    const dom = await everything(page);
    const leaks = SECRETS.filter(s => dom.includes(s.norm)).map(s => s.what);
    expect(!leaks.length, 'print: nothing of the hunt is in the page while locked' + (leaks.length ? ': ' + leaks.join('; ') : ''));
  }
  await page.getByLabel('MC passphrase').fill('wrong horse battery staple');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  expect(await until(page, 'That passphrase doesn’t open this hunt', 15000), 'print: a wrong passphrase is refused');
  await page.getByLabel('MC passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  expect(await until(page, 'Print the hunt cards', 15000), 'print: the passphrase unlocks the page');
  await page.evaluate(() => document.fonts.ready);
  await sleep(300);
  const expected = ALL_CODES.slice().sort();
  const want = expected.map(c => PAGES_URL + '#s=' + c);
  // Every card's QR, decoded from the screen.
  const els = await page.$$('.sheet:not(.sheet--key) .card');
  const got = [];
  for (const el of els) {
    const png = PNG.sync.read(await el.screenshot());
    const q = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    got.push(q ? q.data : 'unreadable');
  }
  expect(JSON.stringify(got) === JSON.stringify(want), `print: all ${want.length} card QR codes (${ST.length} stations, ${DECOYS.length} decoys) decode to their card links` + (JSON.stringify(got) === JSON.stringify(want) ? '' : ': ' + got.join(' ')));
  const cards = N(await page.evaluate(() => [...document.querySelectorAll('.sheet:not(.sheet--key) .card')].map(c => c.textContent).join(' | ')));
  const onCards = SECRETS.filter(s => !s.key.startsWith('code:') && s.key !== 'decoy' && cards.includes(s.norm)).map(s => s.what);
  expect(!onCards.length, 'print: the cards carry only their code (no title, riddle, hint or setup note)' + (onCards.length ? ': ' + onCards.join('; ') : ''));
  const key = N(await page.evaluate(() => document.querySelector('.sheet--key').innerText));   // innerText: <br> is a line break
  const missing = [];
  ST.forEach((s, i) => { for (const f of ['title', 'phrase', 'clue', 'answer', 'hide', 'solution', 'hint', 'hint2', 'kids', 'setup', 'code']) if (s[f] && !key.includes(N(s[f]))) missing.push(`${i + 1}:${f}`); });
  DECOYS.forEach((d, i) => { if (!key.includes(d.code) || !key.includes(N(d.hide))) missing.push('decoy ' + (i + 1)); });
  expect(!missing.length, 'print: the answer key has every station’s riddle, answer, hiding spot, setup note, solution, hints, little-ones line and code, plus the decoys' + (missing.length ? ': missing ' + missing.join(', ') : ''));
  await page.screenshot({ path: join(OUT, 'print-01-screen.png'), fullPage: false });
  // The printed PDF (Letter): every card's QR decodes from the printed page too.
  const pdf = join(OUT, 'print.pdf');
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: null });
  try {
    const info = execSync('pdfinfo ' + JSON.stringify(pdf)).toString();
    const pages = +info.match(/Pages:\s+(\d+)/)[1];
    const prefix = join(OUT, 'print-pdf');
    for (const f of readdirSync(OUT).filter(f => f.startsWith('print-pdf-'))) rmSync(join(OUT, f));
    execSync(`pdftoppm -r 150 -png ${JSON.stringify(pdf)} ${JSON.stringify(prefix)}`);
    const geo = await page.evaluate(() => [...document.querySelectorAll('.sheet:not(.sheet--key)')].map(sh => {
      const S = sh.getBoundingClientRect();
      return [...sh.querySelectorAll('.card')].map(c => { const r = c.getBoundingClientRect(); return [r.left - S.left, r.top - S.top, r.width, r.height]; });
    }));
    const files = readdirSync(OUT).filter(f => f.startsWith('print-pdf-') && f.endsWith('.png')).sort();
    const decoded = [];
    geo.forEach((onSheet, si) => {
      const png = PNG.sync.read(readFileSync(join(OUT, files[si])));
      const k = png.width / 816;
      for (const [x, y, w, h] of onSheet) {
        const X = Math.round(x * k), Y = Math.round(y * k), Wd = Math.round(w * k), Hd = Math.round(h * k);
        const buf = new Uint8ClampedArray(Wd * Hd * 4);
        for (let r = 0; r < Hd; r++) { const src = ((Y + r) * png.width + X) * 4; buf.set(png.data.subarray(src, src + Wd * 4), r * Wd * 4); }
        const q = jsQR(buf, Wd, Hd);
        decoded.push(q ? q.data : 'unreadable');
      }
    });
    expect(pages >= 2 && JSON.stringify(decoded) === JSON.stringify(want), `print PDF: ${pages} Letter pages; every printed card QR decodes to its card link` + (JSON.stringify(decoded) === JSON.stringify(want) ? '' : ': ' + decoded.join(' ')));
  } catch (e) {
    expect(false, 'print PDF: pdfinfo/pdftoppm (poppler) available and the PDF checks ran: ' + e.message.split('\n')[0]);
  }
  await ctx.close();
}

// =====================================================================================================
async function startOver({ mc, tv, W, B, C, D }) {
  console.log('\n=== Start over: clear progress, then a new game ===');
  mc.answers.push('CLEAR');
  await mc.getByRole('button', { name: /Clear everyone/ }).click();
  for (const p of [W, B, C]) expect(await until(p, 'You’re in'), `clear progress: ${p.devName}'s phone is back to waiting`);
  expect(await tvShows(tv, 'waiting'), 'clear progress: the TV is back to the join screen');
  const t = game();
  expect(!t.meta || (!t.meta.startedAt && !t.meta.startKey && !t.meta.release), 'clear progress: start, start key and releases are gone from the database');
  expect(Object.keys(t.players || {}).length === 3 && Object.values(t.players).every(p => !p.found && !p.solved && !p.gifts && !p.finishedAt), 'clear progress: the 3 players stay, with no progress');
  for (const p of [W, B, C]) await phoneSecretsOk(p, 'after clear progress');
  expect(await until(mc, 'Everyone’s progress is cleared'), 'MC confirms the clear in words');
  mc.answers.push('NEW');
  await mc.getByRole('button', { name: /New game/ }).click();
  for (const p of [W, B, C, D]) expect(await until(p, 'Who’s playing?'), `new game: ${p.devName}'s phone is back to sign-up`);
  expect(await untilTv(tv, 'Nobody yet. Scan the code to be first.'), 'new game: the TV roster is empty');
  expect(!game().players && !game().meta, 'new game: no players and no meta in the database');
  for (const p of [mc, tv, W, B, C, D]) await p.ctx.close();
}

// =====================================================================================================
// Weak Wi-Fi at the party: the database refuses writes for a while, and the TV's live stream drops and its
// reconnection is answered with 503. Nothing is lost and nothing needs a reload.
async function weakWifi() {
  console.log('\n=== Weak Wi-Fi: a refused save is retried until it lands; the TV gets its stream back ===');
  const P = await device('Shepherds');
  await register(P, { name: 'The Shepherds', pin: '5555', members: 'Luke, Anna' });
  expect(await until(P, 'You’re in'), 'weak Wi-Fi: a team registers on a new game');
  const id = await P.evaluate(k => localStorage.getItem(k), ME_KEY);
  const tv = await device('TV (weak Wi-Fi)', 'tv', 'tv.html');
  expect(await untilTv(tv, 'The Shepherds'), 'weak Wi-Fi: the TV lists the team');
  dbPut(['games', GAME, 'meta'], { startedAt: Date.now(), startKey: MC_COPY.startKey });   // the MC's Start, as it arrives
  expect(await until(P, ST[0].clue) && await tvShows(tv, 'race'), 'weak Wi-Fi: the hunt starts (clue 1 on the phone, the race on the TV)');

  // ----- the database answers every write with 503 for a while -----
  const found = () => run(((game().players || {})[id] || {}).found);
  net.refused = 0;
  net.refuseWrites = true;
  await typeCode(P, ST[0].code);
  expect(await until(P, ST[0].title), 'refused save: the phone opens the station at once');
  expect(await until(P, 'Saving… waiting for the connection.'), 'refused save: the phone says the save is waiting for the connection');
  for (let i = 0; i < 100 && net.refused < 2; i++) await sleep(100);
  expect(net.refused >= 2 && !found().length, `refused save: it is tried again (${net.refused} tries refused) and is not in the database yet`);
  await shot(P, 'phone-07-save-waiting');
  net.refuseWrites = false;
  let landed = false;
  for (let i = 0; i < 300 && !(landed = found()[0] === ST[0].code); i++) await sleep(100);
  expect(landed, `refused save: it lands once the database takes writes again (after ${net.refused} refused tries)`);
  expect(await gone(P, 'Saving… waiting for the connection.') && await until(P, ST[0].title), 'refused save: the waiting note goes and the station stays on screen');
  await phoneSecretsOk(P, 'after the refused save');

  // ----- the TV's connection drops, and its reconnection is answered once with 503 -----
  const failed = net.failedStreams;
  net.failStreams.set(tv.ctx.dev, 1);
  dropStreams(tv.ctx.dev);
  await solveTask(P, 0, { label: 'weak Wi-Fi station 1' });   // happens while the TV is cut off
  for (let i = 0; i < 150 && net.failedStreams === failed; i++) await sleep(100);
  expect(net.failedStreams > failed, 'TV: its reconnection was answered with 503');
  expect(await untilTv(tv, 'The Shepherds wrote', 20000), 'TV: it gets a new stream by itself and shows what happened meanwhile');
  expect(await tv.waitForFunction(() => window.StarStore.connected && document.getElementById('offline').hidden, null, { timeout: 10000 }).then(() => true, () => false),
    'TV: connected again, no "Reconnecting…" bar');
  await tvSecretsOk(tv, 'after the 503');
  await shot(tv, 'tv-05-after-503');
  for (const p of [P, tv]) await p.ctx.close();
}

// =====================================================================================================
// The owner's feedback: the MC can pause the whole game (for another activity), end it early (whoever leads wins),
// and reveal the results on the TV (Isaiah 9:6, then 4th up to 1st, then everyone with Luke 2:11).
const clockSecs = s => String(s || '').trim().split(':').reduce((a, x) => a * 60 + (+x || 0), 0);
const tvClock = (tv, sel = '#v-race .js-time') => tv.evaluate(s => document.querySelector(s).textContent.trim(), sel);
const pausedLayerOn = (tv, on = true, ms = 8000) => tv.waitForFunction(on => { const v = document.getElementById('v-paused'); return !!v && v.classList.contains('is-off') !== on; }, on, { timeout: ms, polling: 100 }).then(() => true, () => false);
// A task step tried while paused, as a tap that beat the screen would (the held controls let go in the same moment).
async function forceTaskStep(page, k) {
  const c = ST[k].challenge || {};
  await page.evaluate(([type, value]) => {
    document.querySelectorAll('[data-held]').forEach(e => { e.disabled = false; });
    const q = s => document.querySelector(s);
    if (type === 'word') { const f = q('#word-form'); f.answer.value = value; f.querySelector('button').click(); }
    else if (type === 'order') [...document.querySelectorAll('#tiles .tile')].find(t => t.textContent === value).click();
    else if (type === 'gifts') { const f = q('#gift-form'); f.gift.value = value; f.querySelector('button').click(); }
    else q('#together-btn').click();
  }, [c.type, c.type === 'word' ? c.answers[0] : c.type === 'order' ? c.items[0] : 'A gift held for the pause']);
}
// The MC console shows its change at once; the database has it a moment later.
async function dbWait(fn, ms = 6000) { for (let i = 0; i < ms / 50; i++) { if (fn(game().meta || {})) return true; await sleep(50); } return !!fn(game().meta || {}); }
// What a store write says when it is refused ('ok' when it went through).
const storeTry = (page, call) => page.evaluate(async ([call, code, me]) => {
  const id = localStorage.getItem(me);
  try { await (call === 'find' ? StarStore.findCard(id, code) : StarStore.solveCard(id, code, 99)); return 'ok'; }
  catch (e) { return e && e.code; }
}, [call, ST[1].code, ME_KEY]);

async function pauseEndReveal() {
  console.log('\n=== Pause, end early and the reveal (MC console, TV and phones on separate devices) ===');
  dbPut(['games', GAME], null);   // a new game for this part
  const mc = await device('MC (pause)', 'mc', 'mc.html');
  await mc.getByLabel('MC passphrase').fill(PASS);
  await mc.getByRole('button', { name: 'Go', exact: true }).click();
  expect(await until(mc, 'Ready when you are', 15000), 'pause: the MC console unlocks');
  expect(!(await mc.getByRole('button', { name: 'Pause the hunt', exact: true }).count()), 'MC: no Pause before the start');
  const tv = await device('TV (pause)', 'tv', 'tv.html');
  // Five players on five phones. The race below leaves them 1st to 5th as listed.
  const people = [['Mom & Ellie', '1212', 'Megan, Ellie'], ['Grace', '2323'], ['Ryan & Sam', '3434', 'Ryan, Sam'], ['Dad', '4545'], ['Ben', '5656']];
  const ph = [];
  for (const [name, pin, members] of people) {
    const p = await device(name);
    await register(p, members ? { name, pin, members } : { name, pin });
    expect(await until(p, 'You’re in'), `pause: "${name}" joins on their own phone`);
    p.pid = await p.evaluate(k => localStorage.getItem(k), ME_KEY);
    ph.push(p);
  }
  const [M, G, R, D, Bn] = ph;
  const TOP4 = people.slice(0, 4).map(p => p[0]);
  const rec = p => ((game().players || {})[p.pid]) || {};
  const nFound = p => run(rec(p).found).length, nSolved = p => run(rec(p).solved).length;
  expect(await until(mc, '5 joined'), 'MC: all five are listed');
  mc.answers.push(true);
  await mc.getByRole('button', { name: 'Start the hunt', exact: true }).click();
  for (const p of ph) expect(await until(p, ST[0].clue), `pause: clue 1 on ${p.devName}'s phone`);
  expect(await tvShows(tv, 'race'), 'pause: the TV shows the race');
  // Mid-race: Mom & Ellie 5 stations, Grace 3 and standing at the 4th (task not done), Ryan & Sam 2, Dad 1, Ben none.
  for (let k = 0; k < 5; k++) await playStation(M, k, { quick: true });
  for (let k = 0; k < 3; k++) await playStation(G, k, { quick: true });
  for (let k = 0; k < 2; k++) await playStation(R, k, { quick: true });
  await playStation(D, 0, { quick: true });
  await typeCode(G, ST[3].code);
  expect(await until(G, ST[3].title), 'Grace opens station 4 and stands at its task');
  expect(await until(D, ST[1].clue), 'Dad is on clue 2');
  await sleep(1200);   // let the race clock show a few seconds

  // ----- MC pauses mid-race -----
  await mc.getByRole('button', { name: 'Pause the hunt', exact: true }).click();
  expect(await until(mc, 'Pause the hunt now?'), 'MC: Pause asks for a light confirmation');
  await mc.getByRole('button', { name: 'Pause now', exact: true }).click();
  const pausedAt = Date.now();
  expect(await until(mc, 'Paused since') && await until(mc, 'Resume the hunt'), 'MC: "Paused since <time>" with Resume');
  expect(await dbWait(m => m.paused && m.paused.at), 'pause: meta.paused is in the database');
  expect(await pausedLayerOn(tv), 'TV: the paused sign fades in');
  {
    const t = N(await tv.evaluate(() => document.getElementById('v-paused').textContent));
    expect(t.includes('The hunt is paused') && t.includes('Be still, and know that I am God') && t.includes('Psalm 46:10') && t.includes('Please wait for the MC'),
      'TV: "The hunt is paused", Psalm 46:10 and "Please wait for the MC"');
  }
  expect(await tvShows(tv, 'race'), 'TV: the race stays behind the paused sign');
  const frozen1 = await tvClock(tv, '#v-paused .js-time');
  await sleep(2500);
  const frozen2 = await tvClock(tv, '#v-paused .js-time'), race2 = await tvClock(tv);
  expect(frozen1 === frozen2 && race2 === frozen2 && clockSecs(frozen2) > 0, `TV: the clock stands still while paused (${frozen1}, then ${frozen2} 2.5 s later)`);
  await tvSecretsOk(tv, 'paused');
  await shot(tv, 'tv-10-paused');
  await shot(mc, 'mc-10-paused');

  // ----- phones while paused: no card opens, no task finishes -----
  for (const p of ph) expect(await until(p, 'The hunt is paused. Please wait for the MC.'), `${p.devName}: "The hunt is paused. Please wait for the MC."`);
  const gSolved = nSolved(G), dFound = nFound(D);
  {
    const held = await G.evaluate(() => [...document.querySelectorAll('#task-body button, #task-body input, #next-btn')].map(e => e.disabled));
    expect(held.length >= 2 && held.every(Boolean), `Grace: the task controls and "Show the next clue" are held (${held.length})`);
    expect(await until(G, 'The hunt is paused. Please wait for the MC.', 3000, `() => (${NORM_SRC})((document.querySelector('.task') || {}).textContent || '')`),
      'Grace: the task says why it is held');
    await G.evaluate(() => { const t = document.querySelector('.task'); window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 140); });
    await shot(G, 'phone-10-paused-task', { top: false });
    await forceTaskStep(G, 3);   // a tap that beat the screen
    await sleep(500);
    const task = N(await G.evaluate(() => document.querySelector('.task').textContent));
    expect(task.split('The hunt is paused. Please wait for the MC.').length === 2 && !task.includes('Yes.') && await G.locator('#task-body input, #task-body button').count() > 0,
      'Grace: a task step tried while paused is refused with the paused message (said once), and the task stays as it was');
    expect(await storeTry(G, 'solve') === 'paused', 'Grace: the store refuses a solve while paused (\'paused\')');
    expect(!(await txt(G)).includes(N(ST[4].clue)), 'Grace: the next riddle stays hidden');
  }
  {
    const field = D.getByRole('textbox', { name: 'Card code' });
    expect(await field.isDisabled() && await D.getByRole('button', { name: 'Open', exact: true }).isDisabled(), 'Dad: the code field and Open are held');
    await scan(D, ST[1].code);   // the card's link from the camera
    expect(await until(D, 'Scan this card again once the hunt goes on') && await until(D, 'The hunt is paused'), 'Dad: a card scanned while paused is refused with the paused message');
    expect(!(await txt(D)).includes(N(ST[1].title)), 'Dad: the station does not open');
    expect(await storeTry(D, 'find') === 'paused', 'Dad: the store refuses a find while paused (\'paused\')');
    await shot(D, 'phone-10-paused-scan');
    await D.getByRole('button', { name: 'OK', exact: true }).click();
    expect(await until(D, ST[1].clue), 'Dad: OK goes back to clue 2');
  }
  await sleep(800);
  expect(nSolved(G) === gSolved && nFound(D) === dFound, 'pause: nothing reached the database while paused');
  for (const p of [G, D]) await phoneSecretsOk(p, 'paused');
  await D.evaluate(() => { const t = document.querySelector('.entry'); window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 200); });
  await shot(D, 'phone-10-paused-clue', { top: false });
  if (Date.now() - pausedAt < 6000) await sleep(6000 - (Date.now() - pausedAt));

  // ----- MC resumes: the same actions now work -----
  await mc.getByRole('button', { name: 'Resume the hunt', exact: true }).click();
  await mc.getByRole('button', { name: 'Resume now', exact: true }).click();
  const pausedFor = (Date.now() - pausedAt) / 1000;
  expect(await gone(mc, 'Paused since') && await until(mc, 'Pause the hunt'), 'MC: running again after Resume');
  expect(await dbWait(m => !m.paused && m.pausedTotal > 0), `resume: paused is cleared, pausedTotal ${game().meta.pausedTotal} ms`);
  expect(await pausedLayerOn(tv, false), 'TV: the paused sign goes');
  await sleep(1200);
  {
    const after = await tvClock(tv), d = clockSecs(after) - clockSecs(frozen2);
    await sleep(2200);
    const later = await tvClock(tv);
    expect(d >= 0 && d <= 3 && pausedFor >= d + 3 && clockSecs(later) > clockSecs(after),
      `TV: the clock goes on from where it stood, without the paused time (${frozen2}, then ${after} and ${later} after a ${Math.round(pausedFor)} s pause)`);
  }
  for (const p of ph) expect(await gone(p, 'The hunt is paused'), `${p.devName}: the paused bar goes`);
  expect(await G.getByRole('textbox', { name: 'Your answer' }).isEditable(), 'Grace: the task is free again, where she left it');
  await solveTask(G, 3, { label: 'Grace station 4 after the pause' });
  await G.getByRole('button', { name: 'Show the next clue', exact: true }).click();
  expect(await until(G, ST[4].clue) && nSolved(G) === gSolved + 1, 'Grace: after Resume her task is done and clue 5 shows');
  await typeCode(D, ST[1].code);
  expect(await until(D, ST[1].title), 'Dad: after Resume the same card opens');
  for (let i = 0; i < 50 && nFound(D) === dFound; i++) await sleep(100);
  expect(nFound(D) === dFound + 1, 'Dad: the find is in the database');

  // ----- MC ends the hunt early: Mom & Ellie lead -----
  await mc.getByRole('button', { name: 'End the hunt now', exact: true }).click();
  expect(await until(mc, `Mom & Ellie lead with 5 of ${NST}. End now and they win?`), 'MC: the End confirmation names the leader ("Mom & Ellie lead with 5 of 9")');
  await mc.getByRole('button', { name: 'End the hunt now', exact: true }).click();
  expect(await until(mc, 'The hunt has ended') && await mc.getByRole('button', { name: 'Reveal the results on the TV', exact: true }).isVisible(), 'MC: ended, with the Reveal button');
  expect(await dbWait(m => m.ended && m.ended.early === true), 'end: meta.ended is saved with early: true');
  expect(await until(mc, 'Ended early'), 'MC: it says the hunt ended early');
  await mc.evaluate(() => window.scrollTo(0, document.getElementById('hunt-h').getBoundingClientRect().top + window.scrollY - 40));
  await shot(mc, 'mc-11-ended', { top: false });
  expect(await tvShows(tv, 'ended') && await untilTv(tv, 'Gather around'), 'TV: "The hunt has ended. Gather around."');
  {
    const t = await tv.evaluate(`(${TV_TEXT})()`);
    expect(!people.some(([n]) => t.includes(N(n))), 'TV: no places before the reveal');
  }
  const finalTime = await tvClock(tv, '#v-ended .js-time');
  await tvSecretsOk(tv, 'ended');
  await shot(tv, 'tv-11-ended');
  for (const p of ph) expect(await until(p, 'Look at the TV'), `${p.devName}: "The hunt has ended. Look at the TV."`);
  {
    const placeOf = p => p.evaluate(() => { const e = document.querySelector('.result-place'); return e ? e.textContent.trim() : ''; });
    const got = [];
    for (const p of ph) got.push(await placeOf(p));
    expect(JSON.stringify(got) === JSON.stringify(['1st', '2nd', '3rd', '4th', '5th']), 'phones: each shows its own final place (' + got.join(', ') + ')');
  }
  // Further progress is refused.
  const gFound = nFound(G), dSolved = nSolved(D);
  await scan(G, ST[4].code);
  await scan(D, ST[2].code);
  await sleep(1200);
  expect(await until(G, 'Look at the TV') && !(await txt(G)).includes(N(ST[4].title)) && nFound(G) === gFound, 'Grace: a card scanned after the end opens nothing');
  expect(await storeTry(G, 'find') === 'ended' && await storeTry(D, 'solve') === 'ended', 'the store refuses a find and a solve after the end (\'ended\')');
  expect(nSolved(D) === dSolved && nFound(G) === gFound, 'end: nothing reached the database after the end');
  for (const p of ph) await phoneSecretsOk(p, 'ended');
  await shot(G, 'phone-11-ended');

  // ----- MC reveals: the verse, then 4th up to 1st, then everyone with Luke 2:11 -----
  await mc.getByRole('button', { name: 'Reveal the results on the TV', exact: true }).click();
  expect(await tvShows(tv, 'verse'), 'TV: the reveal opens with the verse');
  {
    const t = await tv.evaluate(`(${TV_TEXT})()`);
    expect(ST.every(s => t.includes(N(s.phrase))) && t.includes('Isaiah 9:6'), 'TV: Isaiah 9:6, the whole verse');
  }
  expect(await dbWait(m => m.reveal && m.reveal.at), 'reveal: meta.reveal is saved');
  await shot(tv, 'tv-12-reveal-verse');
  const rows = async () => (await tv.evaluate(() => [...document.querySelectorAll('#rv-places li')].map(li => (li.classList.contains('is-hidden') ? null : li.querySelector('.nm').textContent))))
    .map(n => (n == null ? null : N(n)));
  const placesText = () => tv.evaluate(() => document.getElementById('rv-places').textContent);
  const keys = ['ArrowRight', ' ', 'ArrowRight', 'ArrowRight'];
  for (let place = 4; place >= 1; place--) {
    await tv.keyboard.press(keys[4 - place]);
    const want = TOP4.map((n, i) => (i + 1 >= place ? n : null));
    let got = null;
    for (let i = 0; i < 30; i++) { if (await tvShows(tv, 'places', 200)) { got = await rows(); if (JSON.stringify(got) === JSON.stringify(want)) break; } await sleep(100); }
    const t = await placesText();
    expect(JSON.stringify(got) === JSON.stringify(want) && !TOP4.slice(0, place - 1).some(n => t.includes(n)),
      `TV: ${S_ORD[place]} place revealed (${keys[4 - place] === ' ' ? 'space' : 'right arrow'}): ` + JSON.stringify(got));
    if (place === 4) {
      expect(N(t).includes('Who came closest to the manger'), 'TV: an early end is headed "Who came closest to the manger"');
      await shot(tv, 'tv-12-reveal-4th');
    }
  }
  await tv.keyboard.press('ArrowRight');
  expect(await tvShows(tv, 'final'), 'TV: the final screen');
  {
    const names = await tv.evaluate(() => [...document.querySelectorAll('#rv-final li .nm')].map(e => e.textContent));
    const ords = await tv.evaluate(() => [...document.querySelectorAll('#rv-final li .ord')].map(e => e.textContent));
    const t = await tv.evaluate(`(${TV_TEXT})()`);
    expect(JSON.stringify(names.map(N)) === JSON.stringify(TOP4) && JSON.stringify(ords) === JSON.stringify(['1st', '2nd', '3rd', '4th']),
      'TV final: the top 4 in order: ' + names.map((n, i) => ords[i] + ' ' + n).join(', '));
    expect(!t.includes('Ben') && t.includes('Luke 2:11') && t.includes('Christ the Lord') && t.includes('Merry Christmas'), 'TV final: Luke 2:11 and Merry Christmas, and only the top 4');
  }
  await tvSecretsOk(tv, 'reveal');
  await shot(tv, 'tv-12-reveal-final');
  expect(await until(mc, 'The results are on the TV') && await mc.getByRole('button', { name: 'Reveal again from the start', exact: true }).isVisible(), 'MC: "The results are on the TV", Reveal again and Hide reveal');
  await shot(mc, 'mc-12-revealed');
  // The phones show the places once the TV has shown them all (about 40 s after the press).
  expect(await until(Bn, 'Tonight’s places', 60000), 'Ben (5th): his phone shows the places after the TV');
  {
    const got = await Bn.evaluate(() => [...document.querySelectorAll('.places li:not(.places-gap)')].map(li => { const n = li.querySelector('.nm'); return n ? n.firstChild.textContent : ''; }));
    expect(JSON.stringify(got.map(N)) === JSON.stringify(TOP4.concat('Ben')), 'Ben: the same top 4, then his own 5th place: ' + got.join(', '));
    expect(await Bn.evaluate(() => { const me = document.querySelector('.places li.is-me'); return !!me && /5th/.test(me.textContent) && /You/.test(me.textContent); }), 'Ben: his own row says "You"');
  }
  await phoneSecretsOk(Bn, 'after the reveal');
  await shot(Bn, 'phone-12-after-reveal');

  // ----- MC reopens the hunt: the clock goes on from where it stopped, and progress works again -----
  await mc.getByRole('button', { name: 'Reopen the hunt', exact: true }).click();
  expect(await until(mc, 'Reopen the hunt?'), 'MC: Reopen asks for a confirmation');
  await mc.getByRole('button', { name: 'Reopen the hunt', exact: true }).click();
  expect(await until(mc, 'Pause the hunt') && await gone(mc, 'The hunt has ended'), 'MC: the hunt runs again after Reopen');
  expect(await dbWait(m => !m.ended && !m.reveal), 'reopen: ended and reveal are gone from the database');
  expect(await tvShows(tv, 'race'), 'TV: back to the race after Reopen');
  await sleep(1200);
  {
    const after = await tvClock(tv), d = clockSecs(after) - clockSecs(finalTime);
    expect(d >= 0 && d <= 5, `TV: the clock goes on from the final time (${finalTime}, then ${after})`);
  }
  expect(await until(D, ST[1].title) && await until(G, ST[4].clue), 'phones: back where they were (Dad at station 2, Grace on clue 5)');
  await solveTask(D, 1, { label: 'Dad station 2 after Reopen' });
  for (let i = 0; i < 50 && nSolved(D) === dSolved; i++) await sleep(100);
  expect(nSolved(D) === dSolved + 1, 'Dad: progress is saved again after Reopen');
  for (const p of [mc, tv, ...ph]) await p.ctx.close();
}
const S_ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };

// =====================================================================================================
async function demoMode() {
  console.log('\n=== Demo mode: one browser, tabs share the game ===');
  const ctx = await newContext('phone', false);
  const tab = async (name, path, size) => { const p = watch(await ctx.newPage(), name); if (size) await p.setViewportSize(size); await p.goto(BASE + path); return p; };
  const mc = await tab('demo MC', 'mc.html', { width: 1280, height: 900 });
  await mc.getByLabel('MC passphrase').fill(PASS);
  await mc.getByRole('button', { name: 'Go', exact: true }).click();
  expect(await until(mc, 'Ready when you are', 15000), 'demo: the MC tab unlocks');
  expect(await until(mc, 'Demo mode'), 'demo: the MC console says it is in demo mode');
  const p1 = await tab('demo Ann', 'index.html');
  await register(p1, { name: 'Ann', pin: '1111' });
  const p2 = await tab('demo Ben', 'index.html');
  await register(p2, { name: 'Ben', pin: '2222' });
  expect(await until(p1, 'You’re in') && await until(p2, 'You’re in'), 'demo: each tab is its own player');
  expect(await until(p1, 'Demo mode: only screens in this browser are connected.'), 'demo: the phone says so');
  expect(await until(mc, 'Ben') && await until(mc, 'Ann'), 'demo: the MC tab sees the players from the other tabs');
  const tvTab = await tab('demo TV', 'tv.html', { width: 1280, height: 720 });
  mc.answers.push(true);
  await mc.getByRole('button', { name: 'Start the hunt', exact: true }).click();
  expect(await until(p1, ST[0].clue) && await until(p2, ST[0].clue), 'demo: Start reaches both player tabs');
  expect(await tvShows(tvTab, 'race'), 'demo: the TV tab shows the race');
  await mc.locator('#clue-1 > summary').click();
  expect(await mcRelease(mc, 1, 'hint1'), 'demo: the MC tab releases hint 1 for clue 1');
  expect(await until(p1, ST[0].hint) && await until(p2, ST[0].hint), 'demo: a release reaches the player tabs');
  await playStation(p1, 0, { quick: true });
  expect(await until(p1, ST[1].clue), 'demo: a player tab moves on to clue 2');
  expect(firebaseHits.length === 0, 'demo: no request to Firebase');
  await ctx.close();
}

// =====================================================================================================
const t0 = Date.now();
try {
  await servedFilesCheck();
  const devices = await onlineRace();
  await printCheck();
  await startOver(devices);
  await weakWifi();
  await pauseEndReveal();
  await demoMode();
} catch (e) {
  console.log('FAIL exception: ' + (e && e.stack || e));
  failures++;
}
expect(firebaseHits.length === 0, 'no request ever reached the real Firebase' + (firebaseHits.length ? ': ' + firebaseHits.join(' ') : ''));
expect(outsideHits.length === 0, 'no request went anywhere but the served site and the stand-in database on 127.0.0.1' + (outsideHits.length ? ': ' + [...new Set(outsideHits)].join(' ') : ''));
await browser.close();
server.close();
console.log(`\nScreenshots and the print PDF: ${OUT}`);
console.log(`${checks - failures} of ${checks} checks passed, ${failures} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failures ? 1 : 0);
