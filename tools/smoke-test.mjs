// Headless smoke test in phone viewports. Usage:
//   npx http-server -p 8080 -s &   then   node tools/smoke-test.mjs [outDir]
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL || 'http://localhost:8080/';
const outDir = process.argv[2] || 'screenshots';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
let failures = 0;
const expect = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const ctx = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', e => { logs.push('pageerror: ' + e.message); failures++; });
await page.goto(URL);
await page.waitForTimeout(400);
expect(logs.some(l => l.includes('Cube self-test: all checks passed')), 'self-test passes on load');
const st = await page.evaluate(() => CubeTrainer.selfTest);
expect(st.failed.length === 0, `self-test details: ${st.passed} passed, failed: ${JSON.stringify(st.failed)}`);

// Solver stress test.
const solver = await page.evaluate(() => {
  const C = CubeTrainer; let ok = 0, maxLen = 0, total = 0; const t0 = performance.now(); let worst = 0;
  for (let i = 0; i < 300; i++) {
    const s = C.applyMoves(C.solvedState(), C.randomScramble(25));
    const t1 = performance.now();
    const sol = C.Solver.solve(s).flatMap(x => x.moves);
    worst = Math.max(worst, performance.now() - t1);
    if (C.isSolved(C.applyMoves(s, sol))) ok++;
    maxLen = Math.max(maxLen, sol.length); total += sol.length;
  }
  return { ok, maxLen, avg: total / 300, ms: performance.now() - t0, worst };
});
expect(solver.ok === 300, `solver solved ${solver.ok}/300 (avg ${solver.avg.toFixed(0)} moves, max ${solver.maxLen}, worst ${solver.worst.toFixed(0)} ms)`);

// Layout: nothing overflows the viewport, tap targets >= 44px.
const layout = await page.evaluate(() => {
  const vw = innerWidth, vh = innerHeight;
  const over = [...document.querySelectorAll('#app *')].filter(e => {
    const r = e.getBoundingClientRect(); return r.width && (r.right > vw + 0.5 || r.bottom > vh + 0.5 || r.left < -0.5 || r.top < -0.5);
  }).map(e => e.id || e.className || e.tagName);
  const small = [...document.querySelectorAll('button')].filter(b => b.offsetParent).filter(b => {
    const r = b.getBoundingClientRect(); return r.height < 44 || r.width < 44;
  }).map(b => b.textContent);
  const c = document.querySelector('#cube').getBoundingClientRect();
  return { over, small, cubeFrac: c.height / vh, scrollH: document.documentElement.scrollHeight, vh };
});
expect(layout.over.length === 0, `no element overflows viewport ${JSON.stringify(layout.over)}`);
expect(layout.small.length === 0, `all tap targets >= 44px ${JSON.stringify(layout.small)}`);
expect(layout.scrollH <= layout.vh, 'page does not scroll');
console.log(`     cube stage is ${(layout.cubeFrac * 100).toFixed(0)}% of screen height`);
await page.screenshot({ path: `${outDir}/portrait-solved.png` });

// Swipe test: find each sticker's centroid and swipe; verify the resulting move.
async function swipeOnSlot(slot, dx, dy) {
  const pt = await page.evaluate(s => {
    const p = CubeTrainer.view.hitPolys.find(h => h.slot === s); if (!p) return null;
    const cx = p.pts.reduce((a, q) => a + q[0], 0) / p.pts.length, cy = p.pts.reduce((a, q) => a + q[1], 0) / p.pts.length;
    const r = document.querySelector('#cube').getBoundingClientRect(); return [cx + r.left, cy + r.top];
  }, slot);
  if (!pt) return null;
  const before = await page.evaluate(() => CubeTrainer.game.undo.length);
  await page.mouse.move(pt[0], pt[1]); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(pt[0] + dx * i / 6, pt[1] + dy * i / 6);
  await page.mouse.up();
  await page.waitForTimeout(260);
  return page.evaluate(b => CubeTrainer.game.undo.length > b ? CubeTrainer.game.undo.at(-1) : null, before);
}
// Default view shows U, F, R. F face slot 20 = F top-right corner sticker.
const F = 18, U = 0, R = 9;
const m1 = await swipeOnSlot(F + 2, 0, -50);   // drag front-right column up -> R
expect(m1 === 'R', `swipe front right column up gives R (got ${m1})`);
const m2 = await swipeOnSlot(F + 0, -50, 0);    // drag front top row left -> U
expect(m2 === 'U', `swipe front top row left gives U (got ${m2})`);
const m3 = await swipeOnSlot(R + 6, 0, 50);     // drag right face bottom-left... down -> F? (R col0 = front edge)
expect(m3 === 'F', `swipe right face front column down gives F (got ${m3})`);
const m4 = await swipeOnSlot(F + 4, 40, 0);     // center sticker: should rotate view, not turn
expect(m4 === null, `swipe on center rotates view instead of turning (got ${m4})`);
await page.click('#resetBtn');

// Buttons, undo/redo, timer and solve detection.
await page.click('#scrambleBtn');
await page.waitForTimeout(150);
const scr = await page.textContent('#scrambleText');
expect(scr.trim().split(/\s+/).length === 20, `scramble has 20 moves: ${scr}`);
await page.screenshot({ path: `${outDir}/portrait-scrambled.png` });
await page.click('#moveGrid button[data-move="R"]');
await page.waitForTimeout(80);
const phase = await page.evaluate(() => CubeTrainer.game.phase);
expect(phase === 'running', `timer starts on first move (${phase})`);
await page.click('#hintBtn');
const hinted = await page.$eval('.move-grid .hint', b => b.dataset.move).catch(() => null);
expect(hinted === "R'", `hint highlights R' (got ${hinted})`);
await page.click('#undoBtn'); await page.click('#redoBtn'); await page.click('#undoBtn');
await page.waitForTimeout(500);
// Solve by applying the inverse scramble through the buttons.
const inv = await page.evaluate(() => CubeTrainer.invertAlg(CubeTrainer.game.scramble));
for (const m of inv) await page.click(`#moveGrid button[data-move="${m}"]`);
await page.waitForTimeout(1600);
const after = await page.evaluate(() => ({ phase: CubeTrainer.game.phase, best: CubeTrainer.game.best, moves: CubeTrainer.game.moves }));
expect(after.phase === 'solved', `solve detected (${JSON.stringify(after)})`);
expect(await page.$eval('#celebrate', e => e.classList.contains('show')), 'celebration shown');
await page.screenshot({ path: `${outDir}/portrait-celebrate.png` });
const stored = await page.evaluate(() => localStorage.getItem('cube-trainer:v1'));
expect(stored && JSON.parse(stored).bestMoves === after.moves, `best saved to localStorage ${stored}`);

// Solution mode.
await page.waitForTimeout(3000);
await page.click('#scrambleBtn');
await page.click('#solveBtn');
await page.waitForTimeout(100);
await page.click('#solNext'); await page.click('#solNext');
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/portrait-solution.png` });
let guard = 0;
while (await page.$eval('#solStage', b => !b.disabled) && guard++ < 10) { await page.click('#solStage'); await page.waitForTimeout(50); }
await page.waitForFunction(() => !CubeTrainer.game.queue.length && !CubeTrainer.game.anim, null, { timeout: 30000 });
expect(await page.evaluate(() => CubeTrainer.isSolved(CubeTrainer.game.display)), 'solution mode solves the cube');
expect(await page.evaluate(() => CubeTrainer.game.phase === 'solved' && CubeTrainer.game.assisted), 'assisted solve detected, not recorded as a best');

// Net view + paste.
await page.click('#resetBtn');
await page.click('#pasteBtn');
await page.fill('#pasteInput', "R U R’ U’ F2 x");
await page.click('#pasteApply');
expect((await page.textContent('#pasteError')).includes('"x"'), 'paste rejects bad token');
await page.fill('#pasteInput', "R U R' U' F2");
await page.click('#pasteApply');
expect((await page.textContent('#scrambleText')).trim() === "R U R' U' F2", 'paste applies scramble');
await page.click('#viewBtn');
await page.waitForTimeout(200);
await page.screenshot({ path: `${outDir}/portrait-net.png` });
await ctx.close();

// Other viewports.
for (const [name, opts] of [
  ['landscape', { ...devices['iPhone 13 landscape'] }],
  ['small-portrait', { ...devices['iPhone SE'] }],
  ['android', { ...devices['Pixel 7'] }],
]) {
  const c = await browser.newContext({ ...opts, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', e => { console.log('pageerror', e.message); failures++; });
  await p.goto(URL); await p.waitForTimeout(300);
  await p.click('#scrambleBtn'); await p.waitForTimeout(100);
  const l = await p.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const over = [...document.querySelectorAll('#app *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > vw + 0.5 || r.bottom > vh + 0.5); }).map(e => e.id || e.className);
    const small = [...document.querySelectorAll('button')].filter(b => b.offsetParent).filter(b => { const r = b.getBoundingClientRect(); return r.height < 44 || r.width < 44; }).map(b => b.textContent);
    const c = document.querySelector('#cube').getBoundingClientRect();
    return { over, small, w: vw, h: vh, cube: [Math.round(c.width), Math.round(c.height)] };
  });
  expect(!l.over.length && !l.small.length, `${name} ${l.w}x${l.h}: no overflow, targets ok, cube ${l.cube} ${JSON.stringify(l)}`);
  await p.screenshot({ path: `${outDir}/${name}.png` });
  await c.close();
}
await browser.close();
console.log(logs.filter(l => !l.startsWith('log: PASS')).join('\n'));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
