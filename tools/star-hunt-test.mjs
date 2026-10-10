// Headless walk-through of the Follow the Star hunt in a phone viewport. Usage:
//   npx http-server -p 8080 -s &   then   node tools/star-hunt-test.mjs [outDir]
// Plays every station in order, checks out-of-order, decoy and unknown cards, the
// "bring another phone" join link, and (if jsqr and pngjs are installed) decodes
// every printed QR card.
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.URL || 'http://localhost:8080/') + 'star-hunt/';
const outDir = process.argv[2] || 'screenshots/star-hunt';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let failures = 0;
const expect = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
page.on('pageerror', e => { console.log('pageerror: ' + e.message); failures++; });
await page.goto(BASE);
const hunt = await page.evaluate(() => window.HUNT);
// textContent, not innerText, so CSS uppercase labels don't change what we match.
const text = () => page.locator('#main').textContent();
const scan = async code => { await page.evaluate(c => { location.hash = 's=' + c; }, code); await page.waitForTimeout(50); };
const shot = async name => { await page.waitForTimeout(700); return page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true }); };

expect((await text()).includes('Begin the journey'), 'intro screen shows');
await shot('01-intro');
await page.click('text=Begin the journey');
expect((await text()).includes('Clue 1 of ' + hunt.stations.length), 'first clue shows after Begin');
await shot('02-first-clue');

await scan(hunt.stations[4].code);
const refused = await text();
expect(hunt.notYet.some(l => refused.includes(l)) && refused.includes('Put this card back'), 'card scanned too early is refused');
expect(!(await text()).includes(hunt.stations[4].title), 'refusal does not reveal the station');
await shot('03-not-yet');
await page.click('text=Back to your clue');

await scan(hunt.decoys[0].code);
expect((await text()).includes(hunt.decoyMessage.title), 'decoy card shows Herod message');
await shot('04-decoy');
await page.click('text=Back to your clue');

await page.fill('input.code', 'zzzzzz');
await page.click('form[data-form=code] button');
expect((await text()).includes('isn\'t one of our stars'), 'unknown typed code is rejected');
await page.click('text=Back to your clue');

async function solve(s) {
  const c = s.challenge;
  if (!c) return;
  if (c.type === 'order') for (const item of c.items) await page.click(`#ch .tiles button:text-is("${item}")`);
  if (c.type === 'word') { await page.fill('#ch input', c.answers[0].toUpperCase() + '!'); await page.click('#ch button'); }
  if (c.type === 'together') await page.click('#ch button');
  if (c.type === 'gifts') {
    for (const g of ['Be kinder to my brother', 'Read the Book of Mormon daily']) { await page.fill('#ch input', g); await page.click('#ch form button'); }
    await page.click('#giftsdone');
  }
}

for (const [i, s] of hunt.stations.entries()) {
  if (i === 0) await scan(s.code);
  else {
    // Half the stations are scanned via the camera link, half typed in by hand.
    if (i % 2) { await page.fill('input.code', s.code.toLowerCase()); await page.click('form[data-form=code] button'); }
    else await scan(s.code);
  }
  expect((await text()).includes(s.title), `station ${i + 1} "${s.title}" opens`);
  if (s.challenge) expect(await page.locator('#next').isHidden(), `station ${i + 1}: next clue stays locked until the challenge is done`);
  if (i === 1) {
    // Wrong answer first.
    await page.fill('#ch input', 'everything'); await page.click('#ch button');
    expect((await text()).includes('Not quite'), 'wrong answer is rejected');
  }
  if (i === 0) {
    await page.click(`#ch .tiles button:text-is("${s.challenge.items[2]}")`);
    expect((await text()).includes('Not that one yet'), 'out-of-order tile is rejected');
    // Scanning the next card before finishing this challenge is refused.
    await scan(hunt.stations[1].code);
    expect((await text()).includes('Almost!'), 'next card is refused until the challenge is done');
    await page.click('text=Back to your clue');
  }
  if (i === 0 || i === 6) await shot(`05-station-${i + 1}-challenge`);
  await solve(s);
  expect(await page.locator('#next').isVisible(), `station ${i + 1}: challenge unlocks the next clue`);
  if (i === 4) await shot('06-station-5-no-challenge');
  if (i === 7) await shot('07-station-8-bom');
  await page.click('#next');
  if (i < hunt.stations.length - 1) expect((await text()).includes(`Clue ${i + 2} of`), `clue ${i + 2} shows`);
  if (i === 2) {
    await scan(hunt.stations[0].code);
    expect((await text()).includes('Already found'), 'rescanning an old card shows a recap');
    await page.click('text=Back to your clue');
  }
}
expect((await text()).includes('Glory to God in the highest'), 'finale shows');
expect((await text()).includes('Read the Book of Mormon daily'), 'finale lists the gifts');
await shot('08-finale');

const solidStars = await page.locator('.track span.solved').count();
expect(solidStars === hunt.stations.length, `all ${hunt.stations.length} progress stars lit`);

// Layout: nothing wider than the phone.
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
expect(!overflow, 'no horizontal scroll');

// Bring another phone: a fresh phone joins partway through.
const page2 = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
const joinCodes = hunt.stations.slice(0, 3).map(s => s.code).join('.');
await page2.goto(BASE + '#join=' + joinCodes);
expect((await page2.locator('#main').textContent()).includes('3 of ' + hunt.stations.length), 'join link catches a second phone up');
await page2.click('text=Back to your clue');
expect((await page2.locator('#main').textContent()).includes('Clue 4 of'), 'second phone continues at clue 4');
await page2.goto(BASE + '#join=' + hunt.stations[3].code);
expect((await page2.locator('#main').textContent()).includes('didn\'t work'), 'forged join link is rejected');

// Share screen renders a QR.
await page.click('text=Bring another phone');
expect(await page.locator('.qr svg').count() === 1, 'share screen shows a QR');
await shot('09-share');

// Printed cards.
const pp = await (await browser.newContext({ viewport: { width: 900, height: 1200 } })).newPage();
await pp.goto(BASE + 'print.html');
await pp.fill('#base', 'https://example.org/star-hunt/');
const cardCount = await pp.locator('.qcard').count();
expect(cardCount === hunt.stations.length + hunt.decoys.length, `print sheet has ${cardCount} cards`);
await pp.screenshot({ path: `${outDir}/10-print.png`, fullPage: true });
await pp.pdf({ path: `${outDir}/star-cards.pdf`, format: 'Letter' }).catch(() => {});
let jsQR, PNG;
try { jsQR = (await import('jsqr')).default; ({ PNG } = await import('pngjs')); } catch { console.log('skip QR decode (npm i jsqr pngjs to enable)'); }
if (jsQR) {
  const want = [...hunt.stations, ...hunt.decoys].map(s => 'https://example.org/star-hunt/#s=' + s.code).sort();
  const got = [];
  for (const el of await pp.locator('.qcard svg').all()) {
    const png = PNG.sync.read(await el.screenshot());
    got.push(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data);
  }
  expect(JSON.stringify(got.sort()) === JSON.stringify(want), 'every printed QR decodes to its station link');
}

await browser.close();
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
