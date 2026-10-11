// Headless test of the Follow the Star race: player phones, the TV and the MC screen.
// Usage:  npx http-server -p 8080 -s &   then   node tools/star-hunt-test.mjs [outDir]
// The online game runs against a small in-memory stand-in for the Firebase Realtime
// Database REST API (started here on port 8099), with every screen in its own browser
// context like separate devices. A short second run checks demo mode in one browser.
// Set CHROMIUM to a Chromium path if Playwright's bundled browser isn't installed.
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import http from 'node:http';

const BASE = (process.env.URL || 'http://localhost:8080/') + 'star-hunt/';
const DB_PORT = 8099;
const outDir = process.argv[2] || 'screenshots/star-hunt';
mkdirSync(outDir, { recursive: true });
let failures = 0;
const expect = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// ---------- fake Firebase Realtime Database ----------
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
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  const ps = parts(new URL(req.url, 'http://x').pathname.replace(/\.json$/, ''));
  if (req.method === 'GET') {
    if ((req.headers.accept || '').includes('text/event-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const l = { ps, res };
      listeners.add(l);
      send(res, 'put', { path: '/', data: getAt(ps) });
      res.on('close', () => listeners.delete(l));
      return;
    }
    return res.end(JSON.stringify(getAt(ps)));
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
await new Promise(r => server.listen(DB_PORT, r));

// ---------- helpers ----------
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
// All test contexts share the browser's limit of 6 connections per host, and every
// screen holds one open for live updates, so each device gets its own loopback address.
let deviceCount = 0;
async function device(name, opts, online = true) {
  const ctx = await browser.newContext(opts);
  const host = '127.0.0.' + (++deviceCount + 1);
  if (online) {
    await ctx.route('**/star-hunt/config.js', r => r.fulfill({
      contentType: 'text/javascript',
      body: `window.STAR_HUNT_CONFIG = { firebaseUrl: 'http://${host}:${DB_PORT}', gameId: 'test' };`,
    }));
  }
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log(`pageerror (${name}): ${e.message}`); failures++; });
  page.on('dialog', d => d.accept(page.nextAnswer ?? undefined));
  return page;
}
const phone = devices['iPhone 13'];
// Visible page text, without the inline scripts (whose source would match anything).
const pageText = () => { const b = document.body.cloneNode(true); b.querySelectorAll('script, style, [hidden]').forEach(e => e.remove()); return b.textContent; };
const txt = page => page.evaluate(pageText);
const until = async (page, text, ms = 4000) => {
  try { await page.waitForFunction(([t, f]) => new Function('return (' + f + ')()')().includes(t), [text, pageText.toString()], { timeout: ms }); return true; }
  catch { return false; }
};
const shot = async (page, name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true }); };
const scan = (page, code) => page.evaluate(c => { location.hash = 's=' + c; }, code);
async function typeCode(page, code) { await page.fill('input.code', code); await page.click('form[data-form=code] button'); }

async function register(page, { name, pin, members }) {
  await page.click(members ? 'button:has-text("make a team")' : 'button:has-text("play on my own")');
  await page.fill('input[name=name]', name);
  if (members) await page.fill('input[name=members]', members);
  await page.fill('input[name=pin]', pin);
  await page.click('form[data-form=register] button[type=submit]');
}

async function solve(page, s) {
  const c = s.challenge;
  if (!c) return;
  if (c.type === 'order') for (const item of c.items) await page.click(`#ch .tiles button:text-is("${item}")`);
  if (c.type === 'word') { await page.fill('#ch input', c.answers[0]); await page.click('#ch button'); }
  if (c.type === 'together') await page.click('#ch button');
  if (c.type === 'gifts') { await page.fill('#ch input', 'Serve my neighbors'); await page.click('#ch form button'); await page.click('#giftsdone'); }
}

async function playStation(page, s, label) {
  await until(page, 'Clue');
  await typeCode(page, s.code);
  const opened = await until(page, s.title);
  expect(opened, `${label}: "${s.title}" opens`);
  await solve(page, s);
  await page.waitForSelector('#next:not([hidden])', { timeout: 3000 }).catch(() => {});
  expect(await page.locator('#next').isVisible(), `${label}: task unlocks the next clue`);
  await page.click('#next');
}

// ---------- online race ----------
const mc = await device('mc', { viewport: { width: 1100, height: 900 } });
await mc.goto(BASE + 'mc.html');
const hunt = await mc.evaluate(() => window.HUNT);
const st = hunt.stations;
expect(await until(mc, 'Set up the MC screen'), 'MC asks for a new PIN the first time');
await mc.fill('input.pin', '1225'); await mc.click('form button');
expect(await until(mc, 'Start the hunt'), 'MC controls show after setting the PIN');

const tv = await device('tv', { viewport: { width: 1600, height: 900 } });
await tv.goto(BASE + 'tv.html');
expect(await until(tv, 'Join the hunt'), 'TV shows the join screen before the start');

const ryan = await device('ryan', phone);
await ryan.goto(BASE);
expect(await until(ryan, 'Who\'s playing?'), 'player app asks who is playing');
await shot(ryan, '01-welcome');
await register(ryan, { name: 'Ryan', pin: '1111' });
expect(await until(ryan, 'Waiting for the MC'), 'solo player registers and waits for the start');
await shot(ryan, '02-waiting');

const team = await device('team', devices['Pixel 7']);
await team.goto(BASE);
await register(team, { name: 'Mom & Ellie', pin: '2222', members: 'Mom, Ellie' });
expect(await until(team, 'Waiting for the MC'), 'team registers');

const copycat = await device('copycat', phone);
await copycat.goto(BASE);
await register(copycat, { name: 'ryan', pin: '3333' });
expect(await until(copycat, 'already has that name'), 'duplicate name is refused');

expect(await until(tv, 'Mom & Ellie') && (await txt(tv)).includes('Ryan'), 'TV lists everyone who joined');
expect(await until(mc, 'Mom & Ellie'), 'MC lists everyone who joined');

await scan(ryan, st[0].code);
expect(await until(ryan, 'hasn\'t started yet'), 'card scanned before the start is refused');
await ryan.click('button:has-text("Back to your clue")');

await mc.click('button:has-text("Start the hunt")');
expect(await until(ryan, 'Clue 1 of'), 'start reaches Ryan\'s phone');
expect(await until(team, 'Clue 1 of'), 'start reaches the team\'s phone');
expect(await until(tv, 'The race'), 'TV switches to the race');

await scan(ryan, st[5].code);
const refused = await txt(ryan);
expect(hunt.notYet.some(l => refused.includes(l)) && !refused.includes(st[5].title), 'card found too early is refused without a spoiler');
await ryan.click('button:has-text("Back to your clue")');
await scan(ryan, hunt.decoys[0].code);
expect(await until(ryan, hunt.decoyMessage.title), 'decoy card shows Herod\'s message');
await ryan.click('button:has-text("Back to your clue")');

for (let i = 0; i < 3; i++) await playStation(ryan, st[i], `Ryan ${i + 1}`);
expect(await until(ryan, 'Clue 4 of'), 'Ryan reaches clue 4');
expect(await until(tv, 'Clue 4'), 'TV shows Ryan\'s progress');
await shot(tv, '03-tv-race');

await mc.click('button:has-text("Open clue 1")');
expect(await until(team, 'Opened by the MC'), 'opened clue shows on a stuck phone');
expect(await until(tv, st[0].code), 'opened clue code shows on the TV');
await shot(team, '04-opened-by-mc');
await team.click('button:has-text("Use this code")');
expect(await until(team, st[0].title), 'team uses the opened code');
await shot(team, '05-station');
await solve(team, st[0]);
await team.click('#next');
expect(await until(team, 'Clue 2 of'), 'team moves to clue 2');
expect(!(await txt(team)).includes('Opened by the MC'), 'clue 2 is not opened yet');

// Larry tries to get into Ryan's game on another phone.
const larry = await device('larry', phone);
await larry.goto(BASE);
await until(larry, 'Who\'s playing?');
await larry.click('button.who:has-text("Ryan")');
await larry.fill('input.pin', '9999'); await larry.click('form[data-form=signin] button');
expect(await until(larry, 'isn\'t right'), 'wrong PIN keeps Larry out of Ryan\'s game');
await larry.fill('input.pin', '1111'); await larry.click('form[data-form=signin] button');
expect(await until(larry, 'Clue 4 of'), 'right PIN picks up Ryan\'s game on another phone');

for (let i = 3; i < st.length; i++) await playStation(ryan, st[i], `Ryan ${i + 1}`);
expect(await until(ryan, 'You finished 1st'), 'Ryan finishes first');
expect(await until(tv, 'Ryan reached the manger first'), 'TV announces the first finisher');
expect(await until(tv, 'Serve my neighbors'), 'TV shows the gifts for Him');
await shot(ryan, '06-finished');
await shot(tv, '07-tv-finish');
await shot(mc, '08-mc');

mc.nextAnswer = '4444';
await mc.click('tr:has-text("Mom & Ellie") >> button:has-text("Reset PIN")');
await team.click('button:has-text("Switch player")');
await team.click('button.who:has-text("Mom & Ellie")');
await team.fill('input.pin', '4444'); await team.click('form[data-form=signin] button');
expect(await until(team, 'Clue 2 of'), 'MC PIN reset works and progress is kept');

const overflow = await ryan.evaluate(() => document.documentElement.scrollWidth > innerWidth);
expect(!overflow, 'no sideways scrolling on the phone');

mc.nextAnswer = 'NEW';
await mc.click('button:has-text("New game")');
expect(await until(ryan, 'Who\'s playing?'), 'new game sends phones back to sign-up');
expect(await until(tv, 'Join the hunt'), 'new game resets the TV');

// ---------- demo mode: one browser, tabs share the game ----------
const demoCtx = await browser.newContext(phone);
const tabs = [];
for (let i = 0; i < 3; i++) { const p = await demoCtx.newPage(); p.on('pageerror', e => { console.log('pageerror (demo): ' + e.message); failures++; }); p.on('dialog', d => d.accept(p.nextAnswer)); tabs.push(p); }
await tabs[0].goto(BASE + 'mc.html');
await tabs[0].fill('input.pin', '1225'); await tabs[0].click('form button');
await tabs[1].goto(BASE); await register(tabs[1], { name: 'Ann', pin: '1111' });
await tabs[2].goto(BASE); await register(tabs[2], { name: 'Ben', pin: '2222' });
expect(await until(tabs[0], 'Ben'), 'demo mode: MC tab sees players from other tabs');
await tabs[0].click('button:has-text("Start the hunt")');
expect(await until(tabs[1], 'Clue 1 of') && await until(tabs[2], 'Clue 1 of'), 'demo mode: each tab is its own player');
expect((await txt(tabs[1])).includes('Demo mode'), 'demo mode says so on screen');

await browser.close();
server.close();
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
