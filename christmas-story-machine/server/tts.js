// Optional spoken narration baked into the exported video. Enabled when
// OPENAI_API_KEY is set; otherwise the video carries on-screen captions and the
// live reveal reads narration aloud with the browser's own voice.
import fs from 'node:fs/promises';
import { config } from './config.js';

export const ttsEnabled = () => Boolean(config.ttsKey);

export async function speak(text, outFile) {
  if (!ttsEnabled() || !text) return null;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.ttsKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: config.ttsVoice,
      input: text,
      instructions: 'A warm, gentle grandparent reading a Christmas story aloud to the family by the fire. Unhurried and kind.',
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
  await fs.writeFile(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}
