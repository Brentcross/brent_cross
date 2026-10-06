// A gentle music-box arrangement of "Silent Night" (Gruber, 1818, public
// domain), synthesized at startup so the app ships no audio files and needs
// no licensing. Hosts can upload their own track instead.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const NOTE = { C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G3: 196.0, C3: 130.81, F3: 174.61, G2: 98.0 };

// [note, beats] in 6/8-ish feel; chords are [root, beats] for a soft bass.
const MELODY = [
  ['G4', 1.5], ['A4', 0.5], ['G4', 1], ['E4', 3],
  ['G4', 1.5], ['A4', 0.5], ['G4', 1], ['E4', 3],
  ['D5', 2], ['D5', 1], ['B4', 3],
  ['C5', 2], ['C5', 1], ['G4', 3],
  ['A4', 2], ['A4', 1], ['C5', 1.5], ['B4', 0.5], ['A4', 1], ['G4', 1.5], ['A4', 0.5], ['G4', 1], ['E4', 3],
  ['A4', 2], ['A4', 1], ['C5', 1.5], ['B4', 0.5], ['A4', 1], ['G4', 1.5], ['A4', 0.5], ['G4', 1], ['E4', 3],
  ['D5', 2], ['D5', 1], ['F5', 1.5], ['D5', 0.5], ['B4', 1], ['C5', 3], ['E5', 3],
  ['C5', 1], ['G4', 1], ['E4', 1], ['G4', 1.5], ['F4', 0.5], ['D4', 1], ['C4', 6],
];
const BASS = [
  ['C3', 6], ['C3', 6], ['G2', 6], ['C3', 6], ['F3', 6], ['C3', 6], ['F3', 6], ['C3', 6], ['G2', 6], ['C3', 6], ['C3', 3], ['G2', 3], ['C3', 6],
];

export function synthSilentNight(file, { beat = 0.5, rate = 44100 } = {}) {
  const beats = MELODY.reduce((a, [, b]) => a + b, 0);
  const seconds = beats * beat + 3;
  const n = Math.ceil(seconds * rate);
  const buf = new Float32Array(n);
  const pluck = (freq, start, dur, amp, decay) => {
    const s0 = Math.floor(start * rate);
    const len = Math.min(n - s0, Math.floor((dur + 2.2) * rate));
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const env = Math.min(1, t / 0.004) * Math.exp(-t * decay);
      buf[s0 + i] +=
        amp * env * (Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(2 * Math.PI * freq * 2 * t) * Math.exp(-t * 3) + 0.12 * Math.sin(2 * Math.PI * freq * 3.01 * t) * Math.exp(-t * 6));
    }
  };
  let t = 0.5;
  for (const [note, b] of MELODY) {
    pluck(NOTE[note], t, b * beat, 0.32, 2.6);
    t += b * beat;
  }
  t = 0.5;
  for (const [note, b] of BASS) {
    pluck(NOTE[note], t, b * beat, 0.16, 1.2);
    pluck(NOTE[note] * 1.5, t + beat, b * beat, 0.07, 1.8); // soft fifth
    t += b * beat;
  }
  // tiny echo for a little room
  const d = Math.floor(0.23 * rate);
  for (let i = n - 1; i >= d; i--) buf[i] += buf[i - d] * 0.25;
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const pcm = Buffer.alloc(44 + n * 4);
  pcm.write('RIFF', 0);
  pcm.writeUInt32LE(36 + n * 4, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(rate, 24);
  pcm.writeUInt32LE(rate * 4, 28);
  pcm.writeUInt16LE(4, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round((buf[i] / peak) * 0.8 * 32767);
    pcm.writeInt16LE(v, 44 + i * 4);
    pcm.writeInt16LE(v, 46 + i * 4);
  }
  fs.writeFileSync(file, pcm);
  return file;
}

export function builtInMusic() {
  const file = path.join(config.dataDir, 'silent-night-music-box.wav');
  if (!fs.existsSync(file)) synthSilentNight(file);
  return file;
}
