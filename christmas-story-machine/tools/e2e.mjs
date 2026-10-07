// End-to-end check against a running server: host creates an evening, three
// phones join and submit a story, a drawing and a photo, the host compiles,
// and the share link serves the finished video.
// Usage: BASE=http://localhost:3000 node tools/e2e.mjs [screenshot-dir]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(path.join(process.execPath, '../../lib/node_modules/playwright'));
}
const BASE = process.env.BASE || 'http://localhost:3000';
const shots = process.argv[2] || null;
const tmp = fs.mkdtempSync('/tmp/csm-e2e-');
const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
};
const snap = async (page, name) => shots && page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

// Test images: a "crayon drawing" and a "photo".
const drawing = path.join(tmp, 'drawing.png');
await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#fffdf6"/><path d="M400,120 L640,800 L160,800Z" fill="#2b9a3a"/><circle cx="400" cy="110" r="44" fill="#f5c60a"/><circle cx="330" cy="500" r="20" fill="#e33"/><circle cx="460" cy="640" r="20" fill="#36f"/></svg>')).png().toFile(drawing);
const photo = path.join(tmp, 'photo.jpg');
await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#7a3b2e' } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><circle cx="800" cy="600" r="300" fill="#ffd877"/></svg>') }]).jpeg().toFile(photo);

const browser = await playwright.chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  // Host
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const host = await hostCtx.newPage();
  await host.goto(BASE);
  await host.fill('#evName', 'The E2E Family Christmas Eve');
  await host.click('#createForm button[type=submit]');
  await host.waitForSelector('#created:not(.hidden)');
  const hostUrl = await host.inputValue('#hostLink');
  ok(hostUrl.includes('#key='), 'host link created');
  await host.goto(hostUrl);
  await host.waitForSelector('#app:not(.hidden)');
  const invite = await host.inputValue('#invite');
  ok(invite.includes('/join/'), 'invite link shown on dashboard');
  ok(!(await host.evaluate(() => location.hash)), 'host key removed from the address bar');

  // Outsider cannot see anything
  const stranger = await (await browser.newContext()).newPage();
  const eid = new URL(invite).pathname.split('/')[2];
  const r = await stranger.request.get(`${BASE}/api/e/${eid}/state`);
  ok(r.status() === 403, 'strangers cannot read the event');

  // Three phones
  const phone = async (name, age) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
    const p = await ctx.newPage();
    await p.goto(invite);
    await p.waitForSelector('#app:not(.hidden)');
    await p.fill('#name', name);
    if (age) await p.fill('#age', String(age));
    await p.fill('#family', 'The Testers');
    await p.click('#whoForm button[type=submit]');
    await p.waitForSelector('#pick:not(.hidden)');
    return p;
  };
  const kid = await phone('Lily', 6);
  await snap(kid, 'phone-home');
  await kid.click('.choice[data-type=story]');
  await kid.fill('#text', 'Me and Grandpa built a snowman and our dog ate his carrot nose! We laughed so hard.');
  await snap(kid, 'phone-story');
  await kid.click('#send');
  await kid.waitForSelector('.toast.show');

  const artist = await phone('Max', 4);
  // Max draws right on the screen
  await artist.click('.choice[data-type=drawing]');
  await artist.waitForSelector('.wb-canvas');
  await artist.locator('.wb-canvas').scrollIntoViewIfNeeded();
  const box = await artist.locator('.wb-canvas').boundingBox();
  await artist.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.15);
  await artist.mouse.down();
  for (const [fx, fy] of [[0.25, 0.8], [0.75, 0.8], [0.5, 0.15]]) await artist.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 12 });
  await artist.mouse.up();
  await artist.fill('#title', 'Our Tree');
  await snap(artist, 'phone-drawing');
  await artist.click('#send');

  const aunt = await phone('Aunt Sue');
  // Aunt Sue uses the photo booth with a Santa hat
  await aunt.click('.choice[data-type=photo]');
  await aunt.click('[data-mode=booth]');
  await aunt.click('[data-hat=santa]');
  await aunt.waitForTimeout(800);
  await aunt.click('.booth-snap');
  await aunt.waitForSelector('.booth-retake', { timeout: 10_000 });
  await snap(aunt, 'phone-booth');
  await aunt.click('#send');

  // Wait until all three are ready on the dashboard.
  const deadline = Date.now() + 180_000;
  let state;
  for (;;) {
    state = await (await host.request.get(`${BASE}/api/e/${eid}/state`)).json();
    if (state.contributions.length === 3 && state.contributions.every((c) => c.status === 'ready')) break;
    if (Date.now() > deadline) throw new Error(`timeout: ${JSON.stringify(state.contributions.map((c) => c.status))}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  ok(true, 'story, drawing and photo all processed');
  const d = state.contributions.find((c) => c.type === 'drawing');
  const orig = await host.request.get(`${BASE}/api/e/${eid}/media/${d.id}/original`);
  ok((await orig.body()).subarray(1, 4).toString() === 'PNG', 'whiteboard drawing stored as a PNG');
  const booth = state.contributions.find((c) => c.type === 'photo');
  ok(booth.status === 'ready', 'photo booth picture processed');
  ok(d.caption.length > 0, `drawing got a caption: “${d.caption}”`);

  // A phone sees only its own pieces
  const mine = await (await kid.request.get(`${BASE}/api/e/${eid}/mine`)).json();
  ok(mine.items.length === 1 && mine.total === 3, 'family members see their own pieces and the total');
  await kid.waitForSelector('.pill.ok');
  await snap(kid, 'phone-status');

  // Edit a caption, then compile
  await host.reload();
  await host.waitForSelector('.piece');
  await snap(host, 'host-dashboard');
  await host.request.patch(`${BASE}/api/e/${eid}/settings`, { data: { order: 'family', dedication: 'Christmas Eve 2026' } });
  await host.click('#compile');
  await host.waitForSelector('#doneBox:not(.hidden)', { timeout: 180_000 });
  ok(true, 'keepsake compiled');
  await snap(host, 'host-compiled');
  const share = await host.inputValue('#share');
  ok(share.includes('/s/'), 'share link available');

  // Family can't watch before the reveal; can after.
  ok((await kid.request.get(`${BASE}/api/e/${eid}/keepsake.mp4`)).status() === 404, 'keepsake hidden from family before the reveal');
  const reveal = await hostCtx.newPage();
  await reveal.goto(`${BASE}/reveal/${eid}`);
  await reveal.waitForSelector('#begin');
  await snap(reveal, 'reveal');
  await reveal.click('#begin');
  await reveal.waitForTimeout(800);
  ok((await kid.request.get(`${BASE}/api/e/${eid}/keepsake.mp4`)).status() === 200, 'keepsake available to family after the reveal');

  // Share link works for anyone
  const viewer = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await viewer.goto(share);
  await viewer.waitForFunction(() => document.querySelector('#video').src);
  const vid = await viewer.request.get(`${share}/video.mp4`, { headers: { Range: 'bytes=0-1023' } });
  ok(vid.status() === 206, 'share video streams with range requests');
  await snap(viewer, 'share');
  ok((await viewer.request.get(`${BASE}/s/not-a-real-token-123456/info`)).status() === 404, 'unknown share tokens rejected');
  console.log('\nAll end-to-end checks passed.');
} finally {
  await browser.close();
}
