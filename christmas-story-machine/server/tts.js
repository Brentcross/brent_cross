// Spoken narration baked into the exported video, in the narrator voice the
// host picks (🎅 Santa, a grandparent, or a storyteller).
//
// Providers, in order of preference:
//   ElevenLabs (ELEVENLABS_API_KEY) — choose any voice from their library, e.g.
//     a deep, jolly "Santa" voice, and set its id in ELEVENLABS_VOICE_SANTA
//     (and optionally ELEVENLABS_VOICE_GRANDPARENT / ELEVENLABS_VOICE_STORYTELLER).
//   OpenAI speech (OPENAI_API_KEY) — a built-in voice steered by acting
//     instructions ("a deep, warm, jolly Santa Claus…").
// With neither, the video carries captions and the live reveal reads the
// narration with the browser's voice, pitched to match the narrator.
import fs from 'node:fs/promises';
import { config } from './config.js';

export const NARRATORS = {
  santa: {
    label: 'Santa Claus',
    openaiVoice: 'onyx',
    instructions:
      'You are Santa Claus reading a family’s Christmas Eve keepsake aloud by the fireplace. Speak in a deep, warm, jolly old voice: unhurried, twinkling with kindness, smiling through the words, with the occasional soft, merry chuckle where something is funny. Gentle and hushed for anything sacred or tender. Read the words exactly as written.',
    eleven: () => process.env.ELEVENLABS_VOICE_SANTA || process.env.ELEVENLABS_VOICE_ID,
  },
  grandparent: {
    label: 'A grandparent',
    openaiVoice: 'sage',
    instructions: 'A warm, gentle grandparent reading a Christmas story aloud to the family by the fire. Unhurried, loving and kind. Read the words exactly as written.',
    eleven: () => process.env.ELEVENLABS_VOICE_GRANDPARENT || process.env.ELEVENLABS_VOICE_ID,
  },
  storyteller: {
    label: 'A storyteller',
    openaiVoice: config.ttsVoice,
    instructions: 'A gentle, expressive storyteller narrating a family Christmas film. Warm and clear, with wonder in the voice. Read the words exactly as written.',
    eleven: () => process.env.ELEVENLABS_VOICE_STORYTELLER || process.env.ELEVENLABS_VOICE_ID,
  },
};

const elevenKey = () => process.env.ELEVENLABS_API_KEY || '';
export const ttsEnabled = () => Boolean(elevenKey() || config.ttsKey);

export async function speak(text, outFile, narrator = 'santa') {
  if (!ttsEnabled() || !text) return null;
  const n = NARRATORS[narrator] || NARRATORS.santa;
  let res;
  const voiceId = n.eleven();
  if (elevenKey() && voiceId) {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': elevenKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 } }),
      signal: AbortSignal.timeout(60_000),
    });
  } else if (config.ttsKey) {
    res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.ttsKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: n.openaiVoice, input: text, instructions: n.instructions, response_format: 'mp3' }),
      signal: AbortSignal.timeout(60_000),
    });
  } else {
    return null;
  }
  if (!res.ok) throw new Error(`Narration voice failed: ${res.status}`);
  await fs.writeFile(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}
