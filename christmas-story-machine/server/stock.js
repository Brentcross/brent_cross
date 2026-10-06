// Optional stock photography for slideshow scenes (Pexels, free API key).
// Queries come from Claude's plan and are prefixed with "christmas" and run
// with Pexels' default safe filtering; any failure falls back to illustrations.
import fs from 'node:fs/promises';
import { config } from './config.js';

export async function fetchStockPhoto(query, outFile) {
  if (!config.pexelsKey) return null;
  try {
    const q = encodeURIComponent(`christmas ${query}`.slice(0, 80));
    const res = await fetch(`https://api.pexels.com/v1/search?query=${q}&orientation=landscape&per_page=8&size=large`, {
      headers: { Authorization: config.pexelsKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const photos = data.photos || [];
    if (!photos.length) return null;
    const pick = photos[Math.floor(Math.random() * Math.min(photos.length, 4))];
    const img = await fetch(pick.src.large2x || pick.src.original, { signal: AbortSignal.timeout(30_000) });
    if (!img.ok) return null;
    await fs.writeFile(outFile, Buffer.from(await img.arrayBuffer()));
    return outFile;
  } catch (err) {
    console.warn('[stock]', err.message);
    return null;
  }
}
