// Regenerates icons/*.png by drawing them in headless Chromium.
// Usage: node tools/make-icons.mjs   (needs the playwright package)
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const draw = ({ size, pad }) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#111214';
  g.fillRect(0, 0, size, size);
  // Isometric cube: top white, front-left green, front-right red.
  const s = size * (1 - 2 * pad) / 2;              // edge length on screen
  const cx = size / 2, cy = size / 2 + s * 0.02;
  const ux = Math.cos(Math.PI / 6) * s, uy = Math.sin(Math.PI / 6) * s;
  const top = [cx, cy - s];
  // Face basis vectors (a = along first edge, b = along second edge).
  const faces = [
    { o: top, a: [ux, uy], b: [-ux, uy], color: '#f4f4f4' },               // U
    { o: [cx - ux, cy - s + uy], a: [ux, uy], b: [0, s], color: '#00a65a' }, // F (left)
    { o: [cx, cy], a: [ux, -uy], b: [0, s], color: '#d62030' },              // R (right)
  ];
  g.fillStyle = '#050506';
  g.beginPath();
  g.moveTo(top[0], top[1]); g.lineTo(cx + ux, cy - s + uy); g.lineTo(cx + ux, cy + uy);
  g.lineTo(cx, cy + s); g.lineTo(cx - ux, cy + uy); g.lineTo(cx - ux, cy - s + uy); g.closePath();
  g.lineJoin = 'round'; g.lineWidth = size * 0.03; g.strokeStyle = '#050506'; g.stroke(); g.fill();
  const inset = 0.09;
  for (const f of faces) {
    g.fillStyle = f.color;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const p = (u, v) => [f.o[0] + f.a[0] * u / 3 + f.b[0] * v / 3, f.o[1] + f.a[1] * u / 3 + f.b[1] * v / 3];
      const q = [p(i + inset, j + inset), p(i + 1 - inset, j + inset), p(i + 1 - inset, j + 1 - inset), p(i + inset, j + 1 - inset)];
      g.beginPath(); g.moveTo(...q[0]); q.slice(1).forEach(pt => g.lineTo(...pt)); g.closePath(); g.fill();
    }
  }
  return c.toDataURL('image/png');
};

const browser = await chromium.launch();
const page = await browser.newPage();
const out = [
  ['icons/icon-192.png', 192, 0.14],
  ['icons/icon-512.png', 512, 0.14],
  ['icons/icon-maskable-512.png', 512, 0.24],
  ['icons/apple-touch-icon.png', 180, 0.16],
];
for (const [file, size, pad] of out) {
  const url = await page.evaluate(draw, { size, pad });
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote', file);
}
await browser.close();
