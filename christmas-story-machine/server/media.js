// Image preparation and on-screen text overlays.
//
// Originals are never modified. Everything here reads an original and writes a
// separate derived file used only for video frames. For drawings the derived
// frame places the untouched artwork on a background, scaled uniformly to fit
// (no crop, no filters, no color changes); the only motion later is a gentle
// camera zoom over the whole frame.
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const FW = 3840; // derived frames are 4K so slow Ken Burns zooms stay crisp
const FH = 2160;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Accept anything sharp can decode (JPEG, PNG, WebP, GIF, TIFF, AVIF...). For
// formats it can't (e.g. some HEIC files) fall back to ffmpeg to make a PNG.
export async function decodableSource(originalPath, workPath) {
  try {
    const meta = await sharp(originalPath, { failOn: 'none' }).metadata();
    if (meta.width && meta.height) return { path: originalPath, meta };
  } catch {}
  await new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-y', '-v', 'error', '-i', originalPath, '-frames:v', '1', workPath]);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('This image format could not be read.'))));
  });
  const meta = await sharp(workPath).metadata();
  return { path: workPath, meta };
}

function snowDots(w, h, n, seed = 7) {
  let s = '';
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) s += `<circle cx="${(rnd() * w) | 0}" cy="${(rnd() * h) | 0}" r="${(2 + rnd() * 6).toFixed(1)}" fill="#fff" opacity="${(0.15 + rnd() * 0.35).toFixed(2)}"/>`;
  return s;
}

// The drawing on a warm "gallery" background, with room for a caption beneath.
export async function drawingFrame(src, out) {
  const boxW = FW * 0.8;
  const boxH = FH * 0.6; // leaves the bottom third free so the caption never covers the art
  const art = await sharp(src, { failOn: 'none' })
    .rotate() // honour the phone's EXIF orientation only
    .resize(Math.round(boxW), Math.round(boxH), { fit: 'inside', kernel: 'lanczos3' })
    .png()
    .toBuffer({ resolveWithObject: true });
  const { width: aw, height: ah } = art.info;
  const mat = 36;
  const left = Math.round((FW - aw) / 2);
  const top = Math.round(FH * 0.07 + (boxH - ah) / 2);
  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${FW}" height="${FH}">
    <defs><radialGradient id="g" cx=".5" cy=".4" r=".8"><stop offset="0" stop-color="#2c4a7a"/><stop offset="1" stop-color="#0d1a36"/></radialGradient>
    <filter id="sh" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="28"/></filter></defs>
    <rect width="${FW}" height="${FH}" fill="url(#g)"/>${snowDots(FW, FH, 220)}
    <rect x="${left - mat + 24}" y="${top - mat + 40}" width="${aw + mat * 2}" height="${ah + mat * 2}" fill="#000" opacity=".45" filter="url(#sh)"/>
    <rect x="${left - mat}" y="${top - mat}" width="${aw + mat * 2}" height="${ah + mat * 2}" rx="6" fill="#fbf7ee"/>
    <rect x="${left - mat - 14}" y="${top - mat - 14}" width="${aw + mat * 2 + 28}" height="${ah + mat * 2 + 28}" rx="10" fill="none" stroke="#c9a14a" stroke-width="14"/></svg>`;
  await sharp(Buffer.from(bg))
    .composite([{ input: art.data, left, top }])
    .jpeg({ quality: 93 })
    .toFile(out);
  // Where the art sits, so the camera can drift toward its centre.
  return { cx: (left + aw / 2) / FW, cy: (top + ah / 2) / FH };
}

// A photo filling the frame: blurred copy behind, whole photo in front.
export async function photoFrame(src, out) {
  const img = sharp(src, { failOn: 'none' }).rotate();
  const meta = await sharp(await img.clone().png().toBuffer()).metadata();
  const landscape = meta.width / meta.height >= 1.5;
  if (landscape) {
    await img.resize(FW, FH, { fit: 'cover', position: 'attention' }).jpeg({ quality: 92 }).toFile(out);
    return;
  }
  const back = await img.clone().resize(FW / 8, FH / 8, { fit: 'cover' }).blur(6).modulate({ brightness: 0.55 }).resize(FW, FH).toBuffer();
  const front = await img.clone().resize(Math.round(FW * 0.9), Math.round(FH * 0.94), { fit: 'inside' }).toBuffer({ resolveWithObject: true });
  await sharp(back)
    .composite([{ input: front.data, left: Math.round((FW - front.info.width) / 2), top: Math.round((FH - front.info.height) / 2) }])
    .jpeg({ quality: 92 })
    .toFile(out);
}

export async function svgToFrame(svg, out) {
  await sharp(Buffer.from(svg), { density: 144 }).resize(FW, FH).jpeg({ quality: 92 }).toFile(out);
}

// ------------------------------------------------------------------ text overlays (1280x720 PNG, transparent)
function wrap(text, maxChars) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (!word) continue;
    if ((line + ' ' + word).trim().length > maxChars && line) {
      out.push(line);
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) out.push(line);
  return out;
}

// caption: main text; byline: small line ("Drawn by Lily, age 4"); heading: optional title at top.
// compact: at most two lines, used for drawings so text stays below the artwork.
export async function captionOverlay({ caption = '', byline = '', heading = '' }, out, { compact = false } = {}) {
  const W = config.width;
  const H = config.height;
  let size = 34;
  let lines = wrap(caption, 58);
  if (compact && lines.length > 2) {
    size = 28;
    lines = wrap(caption, 72);
    if (lines.length > 2) lines = [lines[0], lines.slice(1).join(' ').slice(0, 68).replace(/\s+\S*$/, '') + '…'];
  } else if (lines.length > 3) {
    size = 28;
    lines = wrap(caption, 72);
  }
  if (lines.length > 5) lines = [...lines.slice(0, 4), lines.slice(4).join(' ').slice(0, 68) + '…'];
  const lh = size * 1.32;
  const blockH = lines.length * lh + (byline ? 34 : 0) + 34;
  const y0 = H - blockH - 18;
  const text = lines
    .map((l, i) => `<text x="${W / 2}" y="${(y0 + 22 + size + i * lh).toFixed(1)}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="${size}" fill="#fffaf0" stroke="#0b1634" stroke-width="5" stroke-opacity=".55" paint-order="stroke">${esc(l)}</text>`)
    .join('');
  const by = byline
    ? `<text x="${W / 2}" y="${(y0 + 22 + size + lines.length * lh + 6).toFixed(1)}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="21" fill="#ffe2a0" letter-spacing="1.5" stroke="#0b1634" stroke-width="4" stroke-opacity=".5" paint-order="stroke">${esc(byline.toUpperCase())}</text>`
    : '';
  const head = heading
    ? `<rect x="0" y="0" width="${W}" height="110" fill="url(#t)"/><text x="48" y="64" font-family="DejaVu Serif, Georgia, serif" font-style="italic" font-size="34" fill="#fffaf0" stroke="#0b1634" stroke-width="4" stroke-opacity=".5" paint-order="stroke">${esc(heading)}</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1634" stop-opacity="0"/><stop offset=".35" stop-color="#0b1634" stop-opacity=".55"/><stop offset="1" stop-color="#0b1634" stop-opacity=".8"/></linearGradient>
    <linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1634" stop-opacity=".6"/><stop offset="1" stop-color="#0b1634" stop-opacity="0"/></linearGradient></defs>
    ${caption || byline ? `<rect x="0" y="${(y0 - 50).toFixed(1)}" width="${W}" height="${(H - y0 + 50).toFixed(1)}" fill="url(#b)"/>` : ''}${text}${by}${head}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(out);
}

export async function writeEmptyOverlay(out) {
  await sharp({ create: { width: config.width, height: config.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(out);
}

export async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function bylineFor(c, verb) {
  const who = c.name || 'A family member';
  return `${verb} ${who}${c.age ? `, age ${c.age}` : ''}`;
}
