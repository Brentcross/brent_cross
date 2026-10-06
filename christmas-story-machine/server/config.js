import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

export const config = {
  port: int(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  publicDir: path.join(ROOT, 'public'),
  // Public base URL used in invite / share links (e.g. https://story.example.com).
  // When unset, links are built from the request's Host header.
  baseUrl: (process.env.BASE_URL || '').replace(/\/$/, ''),

  // Claude: captions, narration, story planning and safety review.
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  aiEnabled: process.env.AI_DISABLED !== '1' && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  // Send downscaled copies of photos/drawings to Claude so captions can describe them.
  aiVision: process.env.AI_VISION !== '0',
  aiConcurrency: int(process.env.AI_CONCURRENCY, 4),

  // Optional stock photography for text-story slideshows (https://www.pexels.com/api/).
  pexelsKey: process.env.PEXELS_API_KEY || '',
  // Optional spoken narration baked into the exported video (OpenAI speech endpoint).
  ttsKey: process.env.OPENAI_API_KEY || '',
  ttsVoice: process.env.TTS_VOICE || 'fable',

  // Rendering
  renderConcurrency: int(process.env.RENDER_CONCURRENCY, Math.max(1, Math.min(3, os.cpus().length - 1))),
  width: 1280,
  height: 720,
  fps: 25,
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',

  // Upload handling
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 40) * 1024 * 1024,
  maxConcurrentUploads: int(process.env.MAX_CONCURRENT_UPLOADS, 24),
  maxStoryChars: 4000,
};

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

// Server secret used to sign cookies. Persisted so restarts keep everyone signed in.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(config.dataDir, '.secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}
config.secret = loadSecret();
