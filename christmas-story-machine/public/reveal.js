import { $, api, h, eventIdFromPath, fmtDur } from './common.js';

const EID = eventIdFromPath();
const video = $('#video');
let cues = [];
let spoken = new Set();
let voice = null;

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  // Prefer warm, natural-sounding voices when the device has them.
  const pref = [/natural/i, /samantha|daniel|karen|moira|serena|google uk english female|google us english/i];
  for (const re of pref) {
    const v = voices.find((x) => re.test(x.name));
    if (v) return v;
  }
  return voices[0] || null;
}

function speak(text) {
  if (!('speechSynthesis' in window) || !$('#voice').checked) return;
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 0.92;
  u.pitch = 1;
  speechSynthesis.speak(u);
}

async function boot() {
  const me = await api(`/api/e/${EID}/me`).catch(() => ({}));
  if (me.role !== 'host') {
    $('#title').textContent = 'Only the host can start the reveal';
    $('#begin').classList.add('hidden');
    $('#voiceRow').classList.add('hidden');
    $('#hint').textContent = 'Open this page from the host dashboard.';
    return;
  }
  let m;
  try {
    m = await api(`/api/e/${EID}/manifest`);
  } catch {
    $('#title').textContent = 'The keepsake isn’t compiled yet';
    $('#begin').classList.add('hidden');
    $('#hint').textContent = 'Go back to the dashboard and press Compile.';
    return;
  }
  document.title = `${m.name} · The Reveal`;
  $('#title').textContent = m.name;
  const pieces = m.manifest.filter((x) => x.id).length;
  $('#meta').textContent = `${pieces} piece${pieces === 1 ? '' : 's'} from the family · ${fmtDur(m.duration)}`;
  video.src = `/api/e/${EID}/keepsake.mp4?v=${m.version}`;
  if (m.voiceBaked || !('speechSynthesis' in window)) {
    $('#voice').checked = false;
    $('#voiceRow').classList.add('hidden');
  } else {
    voice = pickVoice();
    speechSynthesis.onvoiceschanged = () => (voice = pickVoice());
  }
  // Narration cues: spread each piece's lines across its time on screen.
  cues = [];
  for (const seg of m.manifest) {
    const lines = seg.narration || [];
    lines.forEach((text, i) => cues.push({ at: seg.start + 0.9 + (i * seg.duration) / lines.length, text }));
  }
  $('#begin').onclick = begin;
}

async function begin() {
  try {
    await document.documentElement.requestFullscreen?.();
  } catch {}
  api(`/api/e/${EID}/reveal`, { method: 'POST' }).catch(() => {});
  // Unlock speech on iOS/Safari with a silent utterance inside the tap.
  if ($('#voice').checked) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  $('#intro').classList.add('hidden');
  const count = $('#count');
  count.classList.remove('hidden');
  for (const n of ['3', '2', '1']) {
    count.textContent = n;
    count.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1, offset: 0.25 }, { transform: 'scale(1.15)', opacity: 0 }], { duration: 1000, easing: 'ease-out' });
    await new Promise((r) => setTimeout(r, 1000));
  }
  count.classList.add('hidden');
  $('#curtain').classList.add('fade');
  play();
}

function play() {
  spoken = new Set();
  $('#end').classList.add('hidden');
  video.currentTime = 0;
  video.play();
}

video.addEventListener('timeupdate', () => {
  const t = video.currentTime;
  cues.forEach((c, i) => {
    if (!spoken.has(i) && t >= c.at && t < c.at + 3) {
      spoken.add(i);
      speak(c.text);
    }
  });
});
video.addEventListener('seeking', () => {
  speechSynthesis?.cancel();
  spoken = new Set(cues.map((c, i) => (c.at < video.currentTime ? i : -1)).filter((i) => i >= 0));
});
video.addEventListener('pause', () => speechSynthesis?.pause());
video.addEventListener('play', () => speechSynthesis?.resume());
video.addEventListener('ended', async () => {
  $('#shareQr').src = `/api/e/${EID}/qr.svg?for=share&t=${Date.now()}`;
  try {
    const s = await api(`/api/e/${EID}/state`);
    $('#shareText').textContent = s.shareUrl || '';
  } catch {}
  $('#end').classList.remove('hidden');
});
$('#again').onclick = play;
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && $('#curtain').classList.contains('fade')) {
    e.preventDefault();
    video.paused ? video.play() : video.pause();
  }
});
boot();
