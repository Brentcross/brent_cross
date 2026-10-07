// A finger-friendly drawing pad ("draw it right here"). Crayon colors, three
// brush sizes, an eraser, undo and clear. The finished picture is exported as
// a PNG and treated exactly like a photographed paper drawing: kept as-is.

const COLORS = ['#1d2340', '#d6362b', '#f08a1c', '#f7cf1c', '#2b9a3a', '#2f62d6', '#7a3ad6', '#d63aa0', '#7a4a1a', '#ffffff'];
const SIZES = [['S', 5], ['M', 12], ['L', 26]];
const W = 1200;
const H = 900; // 4:3 paper

export function createWhiteboard(root) {
  root.innerHTML = `
    <div class="wb">
      <div class="wb-tools" role="toolbar" aria-label="Drawing tools">
        <div class="wb-colors">${COLORS.map((c, i) => `<button type="button" class="wb-color" data-color="${c}" aria-label="Color ${i + 1}" style="--c:${c}"${i === 1 ? ' aria-pressed="true"' : ''}></button>`).join('')}</div>
        <div class="wb-row">
          ${SIZES.map(([l, s], i) => `<button type="button" class="wb-btn wb-size" data-size="${s}" aria-label="Brush ${l}"${i === 1 ? ' aria-pressed="true"' : ''}><i style="width:${Math.min(22, s)}px;height:${Math.min(22, s)}px"></i></button>`).join('')}
          <button type="button" class="wb-btn" data-tool="eraser" aria-pressed="false" title="Eraser">🧽</button>
          <button type="button" class="wb-btn" data-tool="undo" title="Undo">↶</button>
          <button type="button" class="wb-btn" data-tool="clear" title="Start over">🗑</button>
        </div>
      </div>
      <canvas class="wb-canvas" width="${W}" height="${H}" aria-label="Drawing area"></canvas>
    </div>`;
  const cv = root.querySelector('canvas');
  const ctx = cv.getContext('2d');
  let color = COLORS[1];
  let size = 12;
  let eraser = false;
  let drawing = false;
  let last = null;
  let strokes = 0;
  const history = [];

  const paper = () => {
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(0, 0, W, H);
  };
  paper();
  const snapshot = () => {
    history.push(ctx.getImageData(0, 0, W, H));
    if (history.length > 25) history.shift();
  };
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H, p: e.pressure && e.pointerType === 'pen' ? e.pressure : 0.6 };
  };
  const press = (sel, el) => {
    root.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
  };

  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    snapshot();
    drawing = true;
    last = pos(e);
    ctx.beginPath();
    ctx.fillStyle = eraser ? '#fffdf7' : color;
    ctx.arc(last.x, last.y, (eraser ? size * 2 : size) / 2, 0, Math.PI * 2);
    ctx.fill();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = pos(ev);
      ctx.strokeStyle = eraser ? '#fffdf7' : color;
      ctx.lineWidth = (eraser ? size * 2 : size) * (0.7 + p.p * 0.6);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      const mx = (last.x + p.x) / 2;
      const my = (last.y + p.y) / 2;
      ctx.quadraticCurveTo(last.x, last.y, mx, my);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    }
  });
  const end = () => {
    if (drawing) strokes++;
    drawing = false;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);

  root.querySelector('.wb-tools').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.color) {
      color = b.dataset.color;
      eraser = false;
      press('.wb-color', b);
      root.querySelector('[data-tool=eraser]').setAttribute('aria-pressed', 'false');
    } else if (b.dataset.size) {
      size = Number(b.dataset.size);
      press('.wb-size', b);
    } else if (b.dataset.tool === 'eraser') {
      eraser = !eraser;
      b.setAttribute('aria-pressed', String(eraser));
    } else if (b.dataset.tool === 'undo') {
      const prev = history.pop();
      if (prev) {
        ctx.putImageData(prev, 0, 0);
        strokes = Math.max(0, strokes - 1);
      }
    } else if (b.dataset.tool === 'clear') {
      snapshot();
      paper();
      strokes = 0;
    }
  });

  return {
    isEmpty: () => strokes === 0,
    toBlob: () => new Promise((res) => cv.toBlob(res, 'image/png')),
    toDataURL: () => cv.toDataURL('image/png'),
    clear: () => {
      history.length = 0;
      paper();
      strokes = 0;
    },
  };
}
