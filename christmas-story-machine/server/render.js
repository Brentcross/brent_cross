// ffmpeg wrappers. Every clip is encoded with identical settings (1280x720,
// 25 fps, H.264 + AAC 48 kHz stereo) so the final compilation can be joined
// without re-encoding.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { config } from './config.js';

const { width: W, height: H, fps: FPS } = config;
const VENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-video_track_timescale', '12800'];
const AENC = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'];

export function run(cmd, args, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.split('\n').filter(Boolean).slice(-6).join(' | ')}`));
    });
  });
}
const ffmpeg = (args, opts) => run(config.ffmpeg, ['-y', '-hide_banner', '-v', 'error', ...args], opts);

export async function probeDuration(file) {
  const ffprobe = config.ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  const out = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Number(out.trim()) || 0;
}

// Smoothstep easing over the shot, as an ffmpeg expression of frame number `on`.
const ease = (N) => `(st(0,on/${N - 1});ld(0)*ld(0)*(3-2*ld(0)))`;

function audioInput(audio, duration) {
  return audio
    ? ['-i', audio]
    : ['-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];
}

// A still frame with a slow camera move. motion: {z0, z1, x0, x1, y0, y1}
// where x/y are 0..1 positions of the camera window across the free space.
export async function kenBurnsShot({ frame, overlay, out, duration, motion, audio }) {
  const N = Math.max(2, Math.round(duration * FPS));
  const m = { z0: 1, z1: 1.12, x0: 0.5, x1: 0.5, y0: 0.5, y1: 0.5, ...motion };
  const e = ease(N);
  const z = `${m.z0}+(${m.z1 - m.z0})*${e}`;
  const x = `(iw-iw/zoom)*(${m.x0}+(${m.x1 - m.x0})*${e})`;
  const y = `(ih-ih/zoom)*(${m.y0}+(${m.y1 - m.y0})*${e})`;
  await ffmpeg([
    '-i', frame,
    '-loop', '1', '-framerate', String(FPS), '-i', overlay,
    ...audioInput(audio, duration),
    '-filter_complex',
    `[0:v]zoompan=z='${z}':x='${x}':y='${y}':d=${N}:s=${W}x${H}:fps=${FPS},setsar=1[bg];` +
      `[1:v]format=rgba[ov];[bg][ov]overlay=0:0:shortest=1,format=yuv420p[v];` +
      `[2:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=600:all=1,apad[a]`,
    '-map', '[v]', '-map', '[a]', '-frames:v', String(N), '-t', (N / FPS).toFixed(3),
    ...VENC, ...AENC, out,
  ]);
}

// A layered "animated scene": slowly pushing backdrop, characters that sway
// and bob, and drifting snow (outdoors) or rising golden sparkles (indoors).
export async function animatedShot({ background, characters, particles, particleMode = 'snow', overlay, out, duration, audio, seed = 0 }) {
  const N = Math.max(2, Math.round(duration * FPS));
  const e = ease(N);
  const sway = 6 + (seed % 5);
  const speed = particleMode === 'snow' ? 55 : 22;
  const s = `mod(t*${speed},${H * 2})`;
  const yA = particleMode === 'snow' ? `${s}-${H * 2}` : `-${s}`;
  const yB = particleMode === 'snow' ? `${s}` : `${H * 2}-${s}`;
  await ffmpeg([
    '-i', background,
    '-loop', '1', '-framerate', String(FPS), '-i', characters,
    '-loop', '1', '-framerate', String(FPS), '-i', particles,
    '-loop', '1', '-framerate', String(FPS), '-i', overlay,
    ...audioInput(audio, duration),
    '-filter_complex',
    `[0:v]zoompan=z='1+0.05*${e}':x='(iw-iw/zoom)*0.5':y='(ih-ih/zoom)*0.6':d=${N}:s=${W}x${H}:fps=${FPS},setsar=1[bg];` +
      `[1:v]scale=${W + 40}:${H + 22},format=rgba[ch];` +
      `[bg][ch]overlay=x='-20+${sway}*sin(2*PI*t/4.2)+12*t/${duration}':y='-14+5*sin(2*PI*t/1.9)':shortest=1[b1];` +
      `[2:v]scale=${W}:${H * 2},format=rgba,split[p1][p2];` +
      `[b1][p1]overlay=x='10*sin(t/1.3)':y='${yA}':shortest=1[b2];` +
      `[b2][p2]overlay=x='10*sin(t/1.3)':y='${yB}':shortest=1[b3];` +
      `[3:v]format=rgba[ov];[b3][ov]overlay=0:0:shortest=1,format=yuv420p[v];` +
      `[4:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=600:all=1,apad[a]`,
    '-map', '[v]', '-map', '[a]', '-frames:v', String(N), '-t', (N / FPS).toFixed(3),
    ...VENC, ...AENC, out,
  ]);
}

// Join shots with cross-dissolves and add a soft fade at both ends.
export async function joinShots(shots, out, { xfade = 0.8, edgeFade = 0.5 } = {}) {
  if (!shots.length) throw new Error('no shots');
  const inputs = shots.flatMap((s) => ['-i', s.file]);
  let filter = '';
  let total = shots[0].duration;
  let v = '[0:v]';
  let a = '[0:a]';
  for (let i = 1; i < shots.length; i++) {
    const offset = (total - xfade).toFixed(3);
    filter += `${v}[${i}:v]xfade=transition=fade:duration=${xfade}:offset=${offset}[v${i}];`;
    filter += `${a}[${i}:a]acrossfade=d=${xfade}[a${i}];`;
    v = `[v${i}]`;
    a = `[a${i}]`;
    total = total + shots[i].duration - xfade;
  }
  const end = Math.max(0, total - edgeFade).toFixed(3);
  filter += `${v}fade=t=in:st=0:d=${edgeFade},fade=t=out:st=${end}:d=${edgeFade},format=yuv420p[vo];`;
  filter += `${a}afade=t=in:st=0:d=${edgeFade},afade=t=out:st=${end}:d=${edgeFade}[ao]`;
  await ffmpeg([...inputs, '-filter_complex', filter, '-map', '[vo]', '-map', '[ao]', '-t', total.toFixed(3), ...VENC, ...AENC, out]);
  return total;
}

// Concatenate finished segments (same encoding) and lay music underneath.
// Narration ducks the music automatically.
export async function compileFinal({ segments, out, music, musicVolume = 0.35, workDir }) {
  const list = `${workDir}/concat.txt`;
  await fs.writeFile(list, segments.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const joined = `${workDir}/joined.mp4`;
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  const total = await probeDuration(joined);
  if (!music) {
    await ffmpeg(['-i', joined, '-c', 'copy', '-movflags', '+faststart', out]);
    return total;
  }
  const fadeStart = Math.max(0, total - 4).toFixed(3);
  await ffmpeg([
    '-i', joined,
    '-stream_loop', '-1', '-i', music,
    '-filter_complex',
    `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${musicVolume},atrim=0:${total.toFixed(3)},afade=t=in:st=0:d=2,afade=t=out:st=${fadeStart}:d=4[m];` +
      `[0:a]asplit=2[n1][n2];[m][n1]sidechaincompress=threshold=0.02:ratio=8:attack=40:release=700[md];` +
      `[n2][md]amix=inputs=2:normalize=0:duration=first[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...AENC, '-t', total.toFixed(3), '-movflags', '+faststart', out,
  ]);
  return total;
}

export async function posterFrame(video, out, at = 2) {
  await ffmpeg(['-ss', String(at), '-i', video, '-frames:v', '1', '-q:v', '3', out]);
}
