// Photo booth: live camera with festive props (a Santa hat, antlers or an elf
// hat you can drag into place, plus an optional holly frame or falling snow),
// a 3-2-1 countdown and a flash. The snapped picture, props and all, is the
// guest's photo. Needs camera permission, which browsers only allow over
// https or on localhost.

const W = 1200;
const H = 900;

const svg = (s) => {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  return img;
};
const HATS = {
  santa: {
    label: '🎅 Santa hat',
    w: 420,
    img: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 320"><path d="M40 250 C70 120 170 30 300 40 C350 44 390 80 380 150 C360 110 330 100 300 110 C260 150 250 210 360 250Z" fill="#c0392b"/><path d="M300 40 C350 44 390 80 380 150 C372 120 352 104 330 100Z" fill="#9e2a20"/><rect x="20" y="230" width="380" height="70" rx="35" fill="#fff"/><circle cx="378" cy="160" r="38" fill="#fff"/></svg>`),
  },
  antlers: {
    label: '🦌 Antlers',
    w: 560,
    img: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 300" fill="none" stroke="#7a5230" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"><path d="M200 290 C180 220 150 170 110 120 M150 180 C110 170 70 150 40 110 M120 130 C110 90 115 50 130 20 M170 230 C130 230 90 220 60 200"/><path d="M360 290 C380 220 410 170 450 120 M410 180 C450 170 490 150 520 110 M440 130 C450 90 445 50 430 20 M390 230 C430 230 470 220 500 200"/><path d="M150 290 Q280 250 410 290" stroke="#c0392b" stroke-width="22"/></svg>`),
  },
  elf: {
    label: '🧝 Elf hat',
    w: 400,
    img: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 340"><path d="M40 270 C80 150 160 40 340 30 C300 80 290 160 360 270Z" fill="#2e7d4f"/><path d="M340 30 l30 -20" stroke="#2e7d4f" stroke-width="18" stroke-linecap="round"/><circle cx="378" cy="8" r="20" fill="#f4d58d"/><path d="M20 250 h360 l-20 70 h-320z" fill="#c0392b"/><g fill="#f4d58d"><circle cx="70" cy="285" r="12"/><circle cx="150" cy="285" r="12"/><circle cx="230" cy="285" r="12"/><circle cx="310" cy="285" r="12"/></g></svg>`),
  },
};

function holly(ctx, x, y, s, flip) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(flip ? -s : s, s);
  ctx.fillStyle = '#1f6b3f';
  for (const a of [-0.5, 0.6]) {
    ctx.save();
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(30, -28, 70, -10);
    ctx.quadraticCurveTo(58, 2, 64, 14);
    ctx.quadraticCurveTo(30, 22, 0, 0);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = '#c0392b';
  for (const [bx, by] of [[4, -6], [16, 2], [2, 10]]) {
    ctx.beginPath();
    ctx.arc(bx, by, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawFrame(ctx, kind, title, t) {
  if (kind === 'holly') {
    ctx.strokeStyle = '#e3b448';
    ctx.lineWidth = 26;
    ctx.strokeRect(13, 13, W - 26, H - 26);
    ctx.strokeStyle = '#b5262b';
    ctx.lineWidth = 8;
    ctx.strokeRect(34, 34, W - 68, H - 68);
    holly(ctx, 50, 50, 1.3, false);
    holly(ctx, W - 50, 50, 1.3, true);
    ctx.fillStyle = 'rgba(11,22,52,.78)';
    ctx.fillRect(0, H - 120, W, 120);
    ctx.fillStyle = '#fffaf0';
    ctx.font = 'italic 56px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(title || 'Merry Christmas', W / 2, H - 48);
  }
  if (kind === 'snow') {
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    for (let i = 0; i < 120; i++) {
      const x = ((i * 97.13) % W) + Math.sin(t / 900 + i) * 12;
      const y = (((i * 53.7) % H) + t * (0.03 + (i % 5) * 0.01)) % H;
      ctx.beginPath();
      ctx.arc(x, y, 2 + (i % 4) * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// `fallback(ctx, t, W, H)` (optional) draws a stand-in subject when no camera is available.
export function createBooth(root, { title = '', onPhoto, fallback } = {}) {
  root.innerHTML = `
    <div class="booth">
      <div class="booth-stage"><canvas width="${W}" height="${H}" aria-label="Photo booth camera view"></canvas><div class="booth-msg" hidden></div></div>
      <div class="booth-row" role="group" aria-label="Hat">${Object.entries(HATS).map(([k, h]) => `<button type="button" class="wb-btn booth-opt" data-hat="${k}" aria-pressed="false">${h.label}</button>`).join('')}<button type="button" class="wb-btn booth-opt" data-hat="" aria-pressed="true">No hat</button></div>
      <div class="booth-row" role="group" aria-label="Frame"><button type="button" class="wb-btn booth-opt" data-frame="holly" aria-pressed="true">🎄 Holly frame</button><button type="button" class="wb-btn booth-opt" data-frame="snow" aria-pressed="false">❄️ Snow</button><button type="button" class="wb-btn booth-opt" data-frame="" aria-pressed="false">No frame</button></div>
      <label class="booth-size" hidden>Hat size <input type="range" min="0.5" max="1.8" step="0.05" value="1"></label>
      <p class="small muted booth-hint" hidden>Drag the hat onto your head.</p>
      <div class="booth-actions"><button type="button" class="btn block booth-snap">📸 Take the picture</button></div>
    </div>`;
  const cv = root.querySelector('canvas');
  const ctx = cv.getContext('2d');
  const msg = root.querySelector('.booth-msg');
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  let stream = null;
  let raf = 0;
  let hat = '';
  let frame = 'holly';
  let hatPos = { x: W / 2, y: H * 0.22, s: 1 };
  let captured = false;
  let countdown = '';
  let flash = 0;
  let useFallback = false;

  const render = (t) => {
    ctx.fillStyle = '#0b1634';
    ctx.fillRect(0, 0, W, H);
    if (useFallback) fallback(ctx, t, W, H);
    else if (video.readyState >= 2) {
      // cover-crop, mirrored like a mirror
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const s = Math.max(W / vw, H / vh);
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
      ctx.restore();
    }
    drawFrame(ctx, frame, title, t);
    if (hat) {
      const h = HATS[hat];
      const w = h.w * hatPos.s;
      const hh = w * (h.img.naturalHeight / h.img.naturalWidth || 0.75);
      if (h.img.complete) ctx.drawImage(h.img, hatPos.x - w / 2, hatPos.y - hh / 2, w, hh);
    }
    if (countdown) {
      ctx.fillStyle = 'rgba(11,22,52,.35)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#f4d58d';
      ctx.font = 'bold 300px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(countdown, W / 2, H / 2);
      ctx.textBaseline = 'alphabetic';
    }
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flash})`;
      ctx.fillRect(0, 0, W, H);
      flash = Math.max(0, flash - 0.08);
    }
  };
  const loop = (t) => {
    if (!captured) render(t);
    raf = requestAnimationFrame(loop);
  };

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return fail(window.isSecureContext ? 'This browser has no camera access. Choose a photo instead.' : 'The photo booth needs a secure (https) link to use the camera. Choose a photo instead.');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      video.srcObject = stream;
      await video.play();
      msg.hidden = true;
    } catch (err) {
      return fail(err && err.name === 'NotAllowedError' ? 'Camera access was blocked. Allow the camera for this site, or choose a photo instead.' : 'The camera could not start. Choose a photo instead.');
    }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    return true;
  }
  function fail(text) {
    if (fallback) {
      useFallback = true;
      msg.textContent = 'No camera here, so a stand-in is posing for you.';
      msg.classList.add('booth-note');
      msg.hidden = false;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
      return false;
    }
    msg.textContent = text;
    msg.hidden = false;
    root.querySelector('.booth-snap').disabled = true;
    render(0);
    return false;
  }
  function stop() {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  // drag the hat
  let dragging = false;
  const toCanvas = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!hat || captured) return;
    dragging = true;
    cv.setPointerCapture(e.pointerId);
    Object.assign(hatPos, toCanvas(e));
  });
  cv.addEventListener('pointermove', (e) => dragging && Object.assign(hatPos, toCanvas(e)));
  cv.addEventListener('pointerup', () => (dragging = false));
  root.querySelector('.booth-size input').addEventListener('input', (e) => (hatPos.s = Number(e.target.value)));

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('hat' in b.dataset) {
      hat = b.dataset.hat;
      root.querySelectorAll('[data-hat]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      root.querySelector('.booth-size').hidden = !hat;
      root.querySelector('.booth-hint').hidden = !hat;
      if (hat === 'antlers') hatPos.y = H * 0.2;
    } else if ('frame' in b.dataset) {
      frame = b.dataset.frame;
      root.querySelectorAll('[data-frame]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    } else if (b.classList.contains('booth-snap')) {
      b.disabled = true;
      for (const n of ['3', '2', '1']) {
        countdown = n;
        await new Promise((r) => setTimeout(r, 800));
      }
      countdown = '';
      render(performance.now());
      captured = true;
      const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
      const dataUrl = cv.toDataURL('image/jpeg', 0.92);
      flash = 0.9;
      const fade = () => {
        if (flash <= 0) return;
        ctx.putImageData(snapshot, 0, 0);
        ctx.fillStyle = `rgba(255,255,255,${flash})`;
        ctx.fillRect(0, 0, W, H);
        flash -= 0.08;
        requestAnimationFrame(fade);
      };
      const snapshot = ctx.getImageData(0, 0, W, H);
      fade();
      setTimeout(() => ctx.putImageData(snapshot, 0, 0), 400);
      root.querySelector('.booth-actions').innerHTML = `<button type="button" class="btn ghost booth-retake" style="color:inherit">↺ Retake</button>`;
      b.disabled = false;
      onPhoto?.(blob, dataUrl);
    } else if (b.classList.contains('booth-retake')) {
      captured = false;
      root.querySelector('.booth-actions').innerHTML = `<button type="button" class="btn block booth-snap">📸 Take the picture</button>`;
      onPhoto?.(null, null);
    }
  });

  return { start, stop, isCaptured: () => captured };
}
