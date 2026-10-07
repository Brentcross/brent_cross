// Illustrated scenes for text stories, drawn from a curated library of flat
// vector motifs. Claude (or the offline planner) only *chooses* a setting and a
// handful of elements from the lists below; it never draws freely. That keeps
// every picture gentle, on-theme and predictable for a room full of children.
//
// Everything is laid out on a 1920x1080 canvas. renderSceneLayers() returns SVG
// strings: a full background, and a transparent "characters" layer, so animated
// scenes can move the characters independently of the backdrop.

export const W = 1920;
export const H = 1080;

export const SETTINGS = [
  'snowy-night', 'winter-village', 'cozy-living-room', 'kitchen', 'nativity-stable',
  'starry-sky', 'snowy-forest', 'church', 'home-exterior', 'summer-day', 'beach',
];

export const ELEMENTS = [
  'christmas-tree', 'presents', 'snowman', 'star', 'moon', 'candles', 'stockings', 'wreath',
  'string-lights', 'bells', 'reindeer', 'sleigh', 'santa', 'angel', 'shepherd', 'sheep',
  'manger', 'donkey', 'wise-man', 'cookies', 'empty-plate', 'cocoa', 'dog', 'cat', 'child', 'adult',
  'grandparent', 'family', 'house', 'sled', 'gingerbread', 'dove', 'piano', 'books', 'car', 'pine-trees',
];

export const TIMES = ['night', 'evening', 'day'];
export const MOODS = ['cozy', 'joyful', 'peaceful', 'reverent', 'magical', 'funny'];

const INDOOR = new Set(['cozy-living-room', 'kitchen']);
const SKY = new Set(['star', 'moon', 'angel', 'dove']);
const WALL = new Set(['stockings', 'wreath', 'string-lights', 'bells']);

// ---------------------------------------------------------------- helpers
const r = (n) => Math.round(n * 10) / 10;
function rng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const PAL = {
  night: { top: '#0b1634', mid: '#1d2f66', low: '#3b4f8f', snow: '#e8eef9', snowShade: '#c3cfe6' },
  evening: { top: '#2a1f5c', mid: '#7a4a8c', low: '#f0a46b', snow: '#f4ecf1', snowShade: '#d9c9db' },
  day: { top: '#5fa8e8', mid: '#9fd0f5', low: '#dff1ff', snow: '#ffffff', snowShade: '#d8e6f3' },
};
const SKIN = ['#f6d2b5', '#e8b48f', '#c98b62', '#8d5a3b', '#5e3b26'];
const CLOTH = ['#c0392b', '#2e7d4f', '#2f5da8', '#8e44ad', '#d35400', '#b03060', '#1f6f78'];
const HAIR = ['#3b2414', '#6b4423', '#c8a165', '#1b1b1b', '#a0522d'];

function starShape(cx, cy, R, rIn, fill, extra = '') {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 ? rIn : R;
    d += `${i ? 'L' : 'M'}${r(cx + Math.cos(a) * rad)},${r(cy + Math.sin(a) * rad)}`;
  }
  return `<path d="${d}Z" fill="${fill}" ${extra}/>`;
}

// ---------------------------------------------------------------- defs
function defs(time) {
  const p = PAL[time] || PAL.night;
  return `<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.top}"/><stop offset=".6" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.low}"/></linearGradient>
  <radialGradient id="glow"><stop offset="0" stop-color="#fff6c8" stop-opacity=".95"/><stop offset=".35" stop-color="#ffe08a" stop-opacity=".45"/><stop offset="1" stop-color="#ffd36b" stop-opacity="0"/></radialGradient>
  <radialGradient id="warm"><stop offset="0" stop-color="#ffcf7a" stop-opacity=".55"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>
  <radialGradient id="vignette" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
  <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a5a34"/><stop offset="1" stop-color="#5e3a1f"/></linearGradient>
  <linearGradient id="fire" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff7b1c"/><stop offset=".6" stop-color="#ffc23d"/><stop offset="1" stop-color="#fff2a8"/></linearGradient>
</defs>`;
}

// ---------------------------------------------------------------- settings (backgrounds)
function skyAndStars(time, rand, count = 90) {
  let s = `<rect width="${W}" height="${H}" fill="url(#sky)"/>`;
  if (time !== 'day') {
    for (let i = 0; i < count; i++) {
      const x = rand() * W, y = rand() * H * 0.55, rad = 0.8 + rand() * 2.4;
      s += `<circle cx="${r(x)}" cy="${r(y)}" r="${r(rad)}" fill="#fffbe8" opacity="${r(0.35 + rand() * 0.6)}"/>`;
    }
  } else {
    for (let i = 0; i < 4; i++) s += cloud(150 + rand() * 1600, 90 + rand() * 220, 0.8 + rand() * 0.6);
  }
  return s;
}
function cloud(x, y, k) {
  return `<g transform="translate(${r(x)},${r(y)}) scale(${r(k)})" fill="#fff" opacity=".9"><ellipse cx="0" cy="0" rx="90" ry="40"/><ellipse cx="60" cy="-25" rx="70" ry="50"/><ellipse cx="120" cy="0" rx="80" ry="38"/></g>`;
}
function snowHills(time, y = 800) {
  const p = PAL[time] || PAL.night;
  return `<path d="M0,${y - 60} C300,${y - 140} 600,${y - 40} 960,${y - 90} S1600,${y - 150} 1920,${y - 70} V1080 H0Z" fill="${p.snowShade}"/>
  <path d="M0,${y} C400,${y - 70} 800,${y + 20} 1200,${y - 30} S1700,${y - 10} 1920,${y - 40} V1080 H0Z" fill="${p.snow}"/>`;
}
function pine(x, base, h, color = '#1f5c3a', snow = true) {
  const w = h * 0.55;
  let s = `<rect x="${r(x - h * 0.04)}" y="${r(base - h * 0.12)}" width="${r(h * 0.08)}" height="${r(h * 0.12)}" fill="#5b3a1e"/>`;
  for (let i = 0; i < 3; i++) {
    const top = base - h + i * h * 0.25, bot = base - h * 0.1 - (2 - i) * h * 0.18;
    const ww = w * (0.55 + i * 0.22);
    s += `<path d="M${r(x)},${r(top)} L${r(x + ww / 2)},${r(bot)} L${r(x - ww / 2)},${r(bot)}Z" fill="${color}"/>`;
    if (snow) s += `<path d="M${r(x)},${r(top)} L${r(x + ww * 0.18)},${r(top + (bot - top) * 0.35)} L${r(x - ww * 0.18)},${r(top + (bot - top) * 0.35)}Z" fill="#f2f6ff" opacity=".9"/>`;
  }
  return s;
}
function villageHouse(x, base, w, h, wall, roof, lit = true) {
  return `<g><rect x="${r(x)}" y="${r(base - h)}" width="${r(w)}" height="${r(h)}" fill="${wall}"/>
  <path d="M${r(x - 20)},${r(base - h)} L${r(x + w / 2)},${r(base - h - h * 0.6)} L${r(x + w + 20)},${r(base - h)}Z" fill="${roof}"/>
  <path d="M${r(x - 20)},${r(base - h)} L${r(x + w / 2)},${r(base - h - h * 0.6)} L${r(x + w + 20)},${r(base - h)} L${r(x + w + 6)},${r(base - h + 14)} L${r(x + w / 2)},${r(base - h - h * 0.6 + 16)} L${r(x - 6)},${r(base - h + 14)}Z" fill="#f2f6ff"/>
  <rect x="${r(x + w * 0.15)}" y="${r(base - h * 0.75)}" width="${r(w * 0.25)}" height="${r(h * 0.3)}" fill="${lit ? '#ffd877' : '#7f8fb3'}"/>
  <rect x="${r(x + w * 0.6)}" y="${r(base - h * 0.75)}" width="${r(w * 0.25)}" height="${r(h * 0.3)}" fill="${lit ? '#ffd877' : '#7f8fb3'}"/>
  <rect x="${r(x + w * 0.4)}" y="${r(base - h * 0.42)}" width="${r(w * 0.2)}" height="${r(h * 0.42)}" fill="#6b3d22"/>
  ${lit ? `<circle cx="${r(x + w * 0.27)}" cy="${r(base - h * 0.6)}" r="${r(w * 0.35)}" fill="url(#warm)"/><circle cx="${r(x + w * 0.72)}" cy="${r(base - h * 0.6)}" r="${r(w * 0.35)}" fill="url(#warm)"/>` : ''}</g>`;
}
function room(time, rand, kitchen) {
  const wall = kitchen ? '#f3e2c4' : '#7b2d34';
  const stripe = kitchen ? '#ead3ad' : '#6c2630';
  let s = `<rect width="${W}" height="${H}" fill="${wall}"/>`;
  for (let x = 0; x < W; x += 80) s += `<rect x="${x}" y="0" width="34" height="860" fill="${stripe}" opacity=".55"/>`;
  // window showing the night (or day) outside
  s += `<g><rect x="1240" y="170" width="420" height="380" rx="10" fill="url(#sky)"/>`;
  if (time !== 'day') for (let i = 0; i < 25; i++) s += `<circle cx="${r(1250 + rand() * 400)}" cy="${r(180 + rand() * 300)}" r="${r(1 + rand() * 2)}" fill="#fff" opacity=".8"/>`;
  s += `<path d="M1240,520 C1320,490 1420,510 1660,480 V550 H1240Z" fill="#e8eef9"/><rect x="1240" y="170" width="420" height="380" rx="10" fill="none" stroke="#f5efe2" stroke-width="22"/><path d="M1450,170 V550 M1240,360 H1660" stroke="#f5efe2" stroke-width="14"/></g>`;
  // floor + rug
  s += `<rect y="860" width="${W}" height="220" fill="${kitchen ? '#c9a77c' : '#6e4426'}"/>`;
  for (let x = 0; x < W; x += 160) s += `<rect x="${x}" y="860" width="4" height="220" fill="#000" opacity=".12"/>`;
  if (kitchen) {
    s += `<rect x="80" y="620" width="900" height="240" fill="#fff8ec"/><rect x="60" y="600" width="940" height="30" fill="#b77b4b"/>`;
    for (let i = 0; i < 4; i++) s += `<rect x="${110 + i * 220}" y="660" width="190" height="170" rx="8" fill="#f1e4cf" stroke="#d8c3a2" stroke-width="4"/><circle cx="${290 + i * 220 - 20}" cy="745" r="7" fill="#b77b4b"/>`;
    s += `<rect x="1040" y="560" width="300" height="300" rx="10" fill="#d9dde3"/><rect x="1070" y="650" width="240" height="160" rx="8" fill="#2c2f36"/><rect x="1080" y="660" width="220" height="140" rx="6" fill="url(#warm)"/>`;
  } else {
    s += `<ellipse cx="900" cy="960" rx="620" ry="80" fill="#a8323e"/><ellipse cx="900" cy="960" rx="560" ry="62" fill="none" stroke="#e8c26a" stroke-width="6" stroke-dasharray="20 14"/>`;
    // fireplace
    s += `<g><rect x="120" y="470" width="560" height="390" fill="#a65a3d"/>`;
    for (let y = 480; y < 860; y += 34) for (let x = 120 + ((y / 34) % 2) * 30; x < 680; x += 60) s += `<rect x="${x}" y="${y}" width="56" height="30" fill="#b9694a" opacity=".6"/>`;
    s += `<rect x="90" y="440" width="620" height="44" fill="#5e3a1f"/><rect x="250" y="620" width="300" height="240" rx="120" ry="120" fill="#24130b"/><rect x="250" y="740" width="300" height="120" fill="#24130b"/>
    <path d="M330,850 C320,760 380,740 370,680 C420,730 440,700 430,650 C500,720 490,790 470,850Z" fill="url(#fire)"/><circle cx="400" cy="780" r="200" fill="url(#warm)"/>
    <rect x="300" y="840" width="200" height="20" rx="10" fill="#6b3d22"/></g>`;
  }
  return s;
}
function stable(time) {
  return `<g><path d="M560,820 V430 L960,250 L1360,430 V820Z" fill="url(#wood)"/>
  <path d="M520,450 L960,230 L1400,450 L1370,470 L960,270 L550,470Z" fill="#4a2c16"/>
  <rect x="680" y="480" width="560" height="340" fill="#2e1a0c"/><ellipse cx="960" cy="650" rx="320" ry="200" fill="url(#warm)"/>
  <path d="M600,820 C700,780 800,800 960,790 C1100,780 1250,800 1330,820Z" fill="#d9b25b"/>
  ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${580 + i * 140}" y="430" width="14" height="390" fill="#4a2c16" opacity=".5"/>`).join('')}</g>`;
}
function churchBuilding(cx, base, k = 1, lit = true) {
  return `<g transform="translate(${cx},${base}) scale(${k})"><rect x="-160" y="-260" width="320" height="260" fill="#efe6d8"/>
  <path d="M-185,-260 L0,-390 L185,-260Z" fill="#7a3b2e"/><rect x="-55" y="-560" width="110" height="300" fill="#efe6d8"/>
  <path d="M-75,-560 L0,-700 L75,-560Z" fill="#7a3b2e"/><rect x="-6" y="-770" width="12" height="80" fill="#d4af37"/><rect x="-30" y="-748" width="60" height="12" fill="#d4af37"/>
  <path d="M-30,-470 a30,30 0 0 1 60,0 v50 h-60z" fill="${lit ? '#ffd877' : '#8090b0'}"/>
  <path d="M-50,0 v-110 a50,50 0 0 1 100,0 v110z" fill="#6b3d22"/>
  <path d="M-130,-150 a25,25 0 0 1 50,0 v70 h-50z M80,-150 a25,25 0 0 1 50,0 v70 h-50z" fill="${lit ? '#ffd877' : '#8090b0'}"/>
  ${lit ? '<circle cx="0" cy="-150" r="260" fill="url(#warm)"/>' : ''}</g>`;
}

function background(setting, time, rand) {
  const p = PAL[time] || PAL.night;
  let s = '';
  switch (setting) {
    case 'cozy-living-room':
      return room(time, rand, false);
    case 'kitchen':
      return room(time, rand, true);
    case 'nativity-stable':
      s += skyAndStars('night', rand, 140) + `<path d="M0,820 C500,760 1400,790 1920,760 V1080 H0Z" fill="#3a3324"/>` + stable(time);
      return s + `<path d="M0,900 C600,860 1300,880 1920,860 V1080 H0Z" fill="#4a4030"/>`;
    case 'starry-sky':
      return skyAndStars(time === 'day' ? 'night' : time, rand, 260) + `<path d="M0,900 C400,820 900,880 1300,840 S1800,860 1920,830 V1080 H0Z" fill="#14203f"/>`;
    case 'snowy-forest':
      s += skyAndStars(time, rand) + snowHills(time, 820);
      for (let i = 0; i < 16; i++) s += pine(60 + i * 125 + rand() * 40, 760 + rand() * 50, 220 + rand() * 160, i % 2 ? '#1f5c3a' : '#2b6e46');
      return s;
    case 'winter-village':
      s += skyAndStars(time, rand) + snowHills(time, 840);
      [[140, 200, 170, '#c46a4a', '#5b2d24'], [420, 240, 200, '#4f7aa8', '#2c3e5c'], [1200, 220, 190, '#d0a55a', '#6b3d22'], [1500, 200, 160, '#8a5a9c', '#3b2450']]
        .forEach(([x, w, h, wall, roof]) => (s += villageHouse(x, 790, w, h, wall, roof, time !== 'day')));
      s += churchBuilding(860, 800, 0.85, time !== 'day');
      return s;
    case 'church':
      s += skyAndStars(time, rand) + snowHills(time, 860) + churchBuilding(960, 820, 1.1, time !== 'day');
      s += pine(380, 830, 300) + pine(1540, 830, 320);
      return s;
    case 'home-exterior':
      s += skyAndStars(time, rand) + snowHills(time, 850);
      s += villageHouse(640, 820, 640, 400, '#b8574a', '#4a2c22', time !== 'day');
      for (let i = 0; i < 14; i++) s += `<circle cx="${640 + i * 46}" cy="428" r="9" fill="${['#ff5e5e', '#ffd84d', '#5ee37a', '#5ec8ff'][i % 4]}"/>`;
      s += pine(300, 840, 340) + pine(1600, 840, 360);
      return s;
    case 'summer-day':
      s += skyAndStars('day', rand) + `<circle cx="1600" cy="190" r="90" fill="#ffe066"/><circle cx="1600" cy="190" r="200" fill="url(#warm)"/>`;
      s += `<path d="M0,800 C500,730 1300,780 1920,740 V1080 H0Z" fill="#7cc46b"/><path d="M0,880 C600,840 1200,880 1920,850 V1080 H0Z" fill="#5daa52"/>`;
      s += [200, 520, 1500].map((x) => `<rect x="${x - 15}" y="620" width="30" height="180" fill="#6b4423"/><circle cx="${x}" cy="580" r="110" fill="#3f8f45"/>`).join('');
      return s;
    case 'beach':
      s += skyAndStars('day', rand) + `<circle cx="1550" cy="200" r="90" fill="#ffe066"/>`;
      s += `<rect y="600" width="${W}" height="220" fill="#3aa0c8"/><path d="M0,640 Q240,620 480,640 T960,640 T1440,640 T1920,640" stroke="#bfe9f7" stroke-width="6" fill="none"/>`;
      s += `<path d="M0,800 C500,770 1300,800 1920,780 V1080 H0Z" fill="#f2d79b"/>`;
      return s;
    case 'snowy-night':
    default:
      s += skyAndStars(time, rand) + snowHills(time, 820);
      s += pine(180, 780, 320) + pine(380, 800, 240) + pine(1560, 790, 300) + pine(1760, 800, 360);
      return s;
  }
}

// ---------------------------------------------------------------- elements
function person(x, base, h, rand, { kind = 'adult', color, hat } = {}) {
  const skin = SKIN[Math.floor(rand() * SKIN.length)];
  const hair = kind === 'grandparent' ? '#d9d9d9' : HAIR[Math.floor(rand() * HAIR.length)];
  const cloth = color || CLOTH[Math.floor(rand() * CLOTH.length)];
  const head = h * 0.13;
  const top = base - h;
  const bodyTop = top + head * 2.1;
  let s = `<g>`;
  s += `<path d="M${r(x - h * 0.16)},${r(base - h * 0.02)} L${r(x - h * 0.12)},${r(bodyTop)} Q${r(x)},${r(bodyTop - head * 0.4)} ${r(x + h * 0.12)},${r(bodyTop)} L${r(x + h * 0.16)},${r(base - h * 0.02)}Z" fill="${cloth}"/>`;
  s += `<rect x="${r(x - h * 0.1)}" y="${r(base - h * 0.04)}" width="${r(h * 0.08)}" height="${r(h * 0.04)}" rx="4" fill="#2b2b2b"/><rect x="${r(x + h * 0.02)}" y="${r(base - h * 0.04)}" width="${r(h * 0.08)}" height="${r(h * 0.04)}" rx="4" fill="#2b2b2b"/>`;
  s += `<path d="M${r(x - h * 0.12)},${r(bodyTop + h * 0.04)} q${r(-h * 0.1)},${r(h * 0.15)} ${r(-h * 0.06)},${r(h * 0.3)}" stroke="${cloth}" stroke-width="${r(h * 0.06)}" stroke-linecap="round" fill="none"/>`;
  s += `<path d="M${r(x + h * 0.12)},${r(bodyTop + h * 0.04)} q${r(h * 0.1)},${r(h * 0.15)} ${r(h * 0.06)},${r(h * 0.3)}" stroke="${cloth}" stroke-width="${r(h * 0.06)}" stroke-linecap="round" fill="none"/>`;
  s += `<rect x="${r(x - h * 0.13)}" y="${r(bodyTop + h * 0.08)}" width="${r(h * 0.26)}" height="${r(h * 0.04)}" fill="#fff" opacity=".85"/>`; // scarf
  s += `<circle cx="${r(x)}" cy="${r(top + head)}" r="${r(head)}" fill="${skin}"/>`;
  s += `<path d="M${r(x - head)},${r(top + head)} a${r(head)},${r(head)} 0 0 1 ${r(head * 2)},0 q${r(-head)},${r(-head * 0.5)} ${r(-head * 2)},0z" fill="${hair}"/>`;
  s += `<circle cx="${r(x - head * 0.35)}" cy="${r(top + head * 1.05)}" r="${r(head * 0.09)}" fill="#2b1d14"/><circle cx="${r(x + head * 0.35)}" cy="${r(top + head * 1.05)}" r="${r(head * 0.09)}" fill="#2b1d14"/>`;
  s += `<path d="M${r(x - head * 0.35)},${r(top + head * 1.4)} q${r(head * 0.35)},${r(head * 0.3)} ${r(head * 0.7)},0" stroke="#7a3b2e" stroke-width="${r(head * 0.08)}" fill="none" stroke-linecap="round"/>`;
  s += `<circle cx="${r(x - head * 0.6)}" cy="${r(top + head * 1.3)}" r="${r(head * 0.16)}" fill="#ff8a8a" opacity=".45"/><circle cx="${r(x + head * 0.6)}" cy="${r(top + head * 1.3)}" r="${r(head * 0.16)}" fill="#ff8a8a" opacity=".45"/>`;
  if (hat === 'santa') s += `<path d="M${r(x - head * 1.05)},${r(top + head * 0.55)} Q${r(x)},${r(top - head * 1.6)} ${r(x + head * 1.5)},${r(top + head * 0.2)} L${r(x + head * 1.05)},${r(top + head * 0.55)}Z" fill="#c0392b"/><rect x="${r(x - head * 1.1)}" y="${r(top + head * 0.4)}" width="${r(head * 2.2)}" height="${r(head * 0.4)}" rx="${r(head * 0.2)}" fill="#fff"/><circle cx="${r(x + head * 1.5)}" cy="${r(top + head * 0.2)}" r="${r(head * 0.28)}" fill="#fff"/>`;
  if (kind === 'grandparent') s += `<path d="M${r(x + h * 0.2)},${r(base)} V${r(base - h * 0.45)} q0,${r(-h * 0.06)} ${r(-h * 0.06)},${r(-h * 0.06)}" stroke="#6b4423" stroke-width="${r(h * 0.025)}" fill="none" stroke-linecap="round"/>`;
  return s + `</g>`;
}
function santa(x, base, h, rand) {
  let s = person(x, base, h, () => 0.1, { color: '#c0392b', hat: 'santa' });
  const head = h * 0.13, top = base - h;
  s += `<path d="M${r(x - head)},${r(top + head * 1.25)} Q${r(x)},${r(top + head * 3.3)} ${r(x + head)},${r(top + head * 1.25)} Q${r(x)},${r(top + head * 1.7)} ${r(x - head)},${r(top + head * 1.25)}Z" fill="#fff"/>`;
  s += `<rect x="${r(x - h * 0.15)}" y="${r(base - h * 0.42)}" width="${r(h * 0.3)}" height="${r(h * 0.05)}" fill="#1b1b1b"/><rect x="${r(x - h * 0.03)}" y="${r(base - h * 0.43)}" width="${r(h * 0.06)}" height="${r(h * 0.07)}" fill="#d4af37"/>`;
  return s;
}
function tree(x, base, h) {
  let s = pine(x, base, h, '#1f6b3f', false);
  const cols = ['#ff4d4d', '#ffd84d', '#4dc3ff', '#ff8ad8', '#ffffff'];
  for (let i = 0; i < 22; i++) {
    const t = (i * 0.61803) % 1, yy = base - h * 0.15 - t * h * 0.7, spread = (1 - t) * h * 0.28;
    const xx = x + Math.sin(i * 2.4) * spread;
    s += `<circle cx="${r(xx)}" cy="${r(yy)}" r="${r(h * 0.022)}" fill="${cols[i % cols.length]}"/>`;
  }
  s += `<circle cx="${r(x)}" cy="${r(base - h)}" r="${r(h * 0.18)}" fill="url(#glow)"/>` + starShape(x, base - h, h * 0.07, h * 0.03, '#ffd84d');
  return s;
}
function present(x, base, w, h, box, ribbon) {
  return `<g><rect x="${r(x - w / 2)}" y="${r(base - h)}" width="${r(w)}" height="${r(h)}" rx="4" fill="${box}"/><rect x="${r(x - w * 0.08)}" y="${r(base - h)}" width="${r(w * 0.16)}" height="${r(h)}" fill="${ribbon}"/><rect x="${r(x - w / 2)}" y="${r(base - h * 0.6)}" width="${r(w)}" height="${r(h * 0.14)}" fill="${ribbon}"/>
  <ellipse cx="${r(x - w * 0.14)}" cy="${r(base - h - w * 0.08)}" rx="${r(w * 0.16)}" ry="${r(w * 0.09)}" fill="${ribbon}"/><ellipse cx="${r(x + w * 0.14)}" cy="${r(base - h - w * 0.08)}" rx="${r(w * 0.16)}" ry="${r(w * 0.09)}" fill="${ribbon}"/></g>`;
}
function quadruped(x, base, h, body, { antlers = false, ears = 'round', wool = false, nose } = {}) {
  const w = h * 1.4;
  let s = `<g>`;
  for (const lx of [-0.38, -0.2, 0.22, 0.38]) s += `<rect x="${r(x + lx * w - h * 0.04)}" y="${r(base - h * 0.45)}" width="${r(h * 0.08)}" height="${r(h * 0.45)}" rx="${r(h * 0.03)}" fill="${body}"/>`;
  if (wool) for (let i = 0; i < 7; i++) s += `<circle cx="${r(x - w * 0.35 + i * w * 0.11)}" cy="${r(base - h * 0.62 + (i % 2) * h * 0.08)}" r="${r(h * 0.18)}" fill="#f5f2ea"/>`;
  else s += `<ellipse cx="${r(x)}" cy="${r(base - h * 0.58)}" rx="${r(w * 0.45)}" ry="${r(h * 0.22)}" fill="${body}"/>`;
  const hx = x + w * 0.5, hy = base - h * 0.85;
  s += `<path d="M${r(x + w * 0.3)},${r(base - h * 0.62)} L${r(hx - h * 0.05)},${r(hy + h * 0.08)}" stroke="${body}" stroke-width="${r(h * 0.16)}" stroke-linecap="round"/>`;
  s += `<ellipse cx="${r(hx + h * 0.06)}" cy="${r(hy)}" rx="${r(h * 0.17)}" ry="${r(h * 0.12)}" fill="${wool ? '#3b302a' : body}"/>`;
  s += `<circle cx="${r(hx + h * 0.06)}" cy="${r(hy - h * 0.03)}" r="${r(h * 0.02)}" fill="#1b1b1b"/>`;
  if (nose) s += `<circle cx="${r(hx + h * 0.22)}" cy="${r(hy + h * 0.01)}" r="${r(h * 0.05)}" fill="${nose}"/>`;
  if (ears === 'long') s += `<ellipse cx="${r(hx - h * 0.04)}" cy="${r(hy - h * 0.2)}" rx="${r(h * 0.04)}" ry="${r(h * 0.14)}" fill="${body}"/>`;
  else s += `<ellipse cx="${r(hx - h * 0.06)}" cy="${r(hy - h * 0.1)}" rx="${r(h * 0.06)}" ry="${r(h * 0.04)}" fill="${wool ? '#3b302a' : body}"/>`;
  if (antlers) s += `<path d="M${r(hx)},${r(hy - h * 0.1)} l${r(-h * 0.05)},${r(-h * 0.3)} m${r(h * 0.02)},${r(h * 0.12)} l${r(-h * 0.12)},${r(-h * 0.08)} m${r(h * 0.1)},${r(-h * 0.12)} l${r(h * 0.08)},${r(-h * 0.07)} M${r(hx + h * 0.1)},${r(hy - h * 0.1)} l${r(h * 0.06)},${r(-h * 0.28)} m${r(-h * 0.03)},${r(h * 0.12)} l${r(h * 0.12)},${r(-h * 0.06)}" stroke="#7a5230" stroke-width="${r(h * 0.035)}" stroke-linecap="round" fill="none"/>`;
  s += `<path d="M${r(x - w * 0.45)},${r(base - h * 0.62)} q${r(-h * 0.12)},${r(-h * 0.05)} ${r(-h * 0.12)},${r(h * 0.12)}" stroke="${wool ? '#f5f2ea' : body}" stroke-width="${r(h * 0.05)}" fill="none" stroke-linecap="round"/>`;
  return s + `</g>`;
}
function pet(x, base, h, kind) {
  const c = kind === 'cat' ? '#e08a3c' : '#a8754a';
  let s = `<g><ellipse cx="${r(x)}" cy="${r(base - h * 0.35)}" rx="${r(h * 0.5)}" ry="${r(h * 0.3)}" fill="${c}"/>`;
  s += `<circle cx="${r(x + h * 0.45)}" cy="${r(base - h * 0.7)}" r="${r(h * 0.28)}" fill="${c}"/>`;
  if (kind === 'cat') s += `<path d="M${r(x + h * 0.25)},${r(base - h * 0.85)} l${r(h * 0.05)},${r(-h * 0.25)} l${r(h * 0.15)},${r(h * 0.15)}Z M${r(x + h * 0.5)},${r(base - h * 0.92)} l${r(h * 0.15)},${r(-h * 0.2)} l${r(h * 0.08)},${r(h * 0.25)}Z" fill="${c}"/><path d="M${r(x - h * 0.5)},${r(base - h * 0.4)} q${r(-h * 0.3)},${r(-h * 0.1)} ${r(-h * 0.2)},${r(-h * 0.5)}" stroke="${c}" stroke-width="${r(h * 0.09)}" fill="none" stroke-linecap="round"/>`;
  else s += `<ellipse cx="${r(x + h * 0.25)}" cy="${r(base - h * 0.62)}" rx="${r(h * 0.1)}" ry="${r(h * 0.22)}" fill="#6b4423"/><circle cx="${r(x + h * 0.72)}" cy="${r(base - h * 0.66)}" r="${r(h * 0.06)}" fill="#1b1b1b"/><path d="M${r(x - h * 0.5)},${r(base - h * 0.45)} q${r(-h * 0.2)},${r(-h * 0.3)} ${r(-h * 0.1)},${r(-h * 0.4)}" stroke="${c}" stroke-width="${r(h * 0.08)}" fill="none" stroke-linecap="round"/><path d="M${r(x + h * 0.3)},${r(base - h * 0.5)} h${r(h * 0.3)}" stroke="#c0392b" stroke-width="${r(h * 0.06)}"/>`;
  s += `<circle cx="${r(x + h * 0.52)}" cy="${r(base - h * 0.74)}" r="${r(h * 0.035)}" fill="#1b1b1b"/>`;
  for (const lx of [-0.3, -0.1, 0.15, 0.35]) s += `<rect x="${r(x + lx * h)}" y="${r(base - h * 0.2)}" width="${r(h * 0.1)}" height="${r(h * 0.2)}" rx="${r(h * 0.04)}" fill="${c}"/>`;
  return s + `</g>`;
}
function snowman(x, base, h) {
  return `<g><circle cx="${r(x)}" cy="${r(base - h * 0.22)}" r="${r(h * 0.22)}" fill="#fbfdff" stroke="#c9d6ea" stroke-width="3"/><circle cx="${r(x)}" cy="${r(base - h * 0.58)}" r="${r(h * 0.16)}" fill="#fbfdff" stroke="#c9d6ea" stroke-width="3"/><circle cx="${r(x)}" cy="${r(base - h * 0.83)}" r="${r(h * 0.12)}" fill="#fbfdff" stroke="#c9d6ea" stroke-width="3"/>
  <rect x="${r(x - h * 0.13)}" y="${r(base - h * 0.95)}" width="${r(h * 0.26)}" height="${r(h * 0.03)}" fill="#222"/><rect x="${r(x - h * 0.08)}" y="${r(base - h * 1.1)}" width="${r(h * 0.16)}" height="${r(h * 0.16)}" fill="#222"/>
  <circle cx="${r(x - h * 0.04)}" cy="${r(base - h * 0.85)}" r="${r(h * 0.015)}" fill="#222"/><circle cx="${r(x + h * 0.04)}" cy="${r(base - h * 0.85)}" r="${r(h * 0.015)}" fill="#222"/><path d="M${r(x)},${r(base - h * 0.81)} l${r(h * 0.12)},${r(h * 0.02)} l${r(-h * 0.12)},${r(h * 0.02)}Z" fill="#ff8c1a"/>
  <path d="M${r(x - h * 0.13)},${r(base - h * 0.71)} h${r(h * 0.26)}" stroke="#c0392b" stroke-width="${r(h * 0.04)}" stroke-linecap="round"/>
  <path d="M${r(x - h * 0.15)},${r(base - h * 0.6)} l${r(-h * 0.2)},${r(-h * 0.15)} M${r(x + h * 0.15)},${r(base - h * 0.6)} l${r(h * 0.2)},${r(-h * 0.15)}" stroke="#6b4423" stroke-width="${r(h * 0.02)}" stroke-linecap="round"/></g>`;
}
function angel(x, y, h) {
  return `<g><circle cx="${r(x)}" cy="${r(y)}" r="${r(h * 0.9)}" fill="url(#glow)"/>
  <path d="M${r(x)},${r(y - h * 0.1)} C${r(x - h * 0.7)},${r(y - h * 0.5)} ${r(x - h * 0.8)},${r(y + h * 0.1)} ${r(x - h * 0.15)},${r(y + h * 0.15)}Z M${r(x)},${r(y - h * 0.1)} C${r(x + h * 0.7)},${r(y - h * 0.5)} ${r(x + h * 0.8)},${r(y + h * 0.1)} ${r(x + h * 0.15)},${r(y + h * 0.15)}Z" fill="#fffaf0" opacity=".95"/>
  <path d="M${r(x - h * 0.18)},${r(y + h * 0.6)} L${r(x - h * 0.08)},${r(y - h * 0.05)} L${r(x + h * 0.08)},${r(y - h * 0.05)} L${r(x + h * 0.18)},${r(y + h * 0.6)}Z" fill="#fff"/>
  <circle cx="${r(x)}" cy="${r(y - h * 0.15)}" r="${r(h * 0.1)}" fill="#f6d2b5"/><ellipse cx="${r(x)}" cy="${r(y - h * 0.3)}" rx="${r(h * 0.12)}" ry="${r(h * 0.03)}" fill="none" stroke="#ffd84d" stroke-width="4"/></g>`;
}
function dove(x, y, h) {
  return `<g fill="#fff"><ellipse cx="${r(x)}" cy="${r(y)}" rx="${r(h * 0.4)}" ry="${r(h * 0.15)}"/><circle cx="${r(x + h * 0.35)}" cy="${r(y - h * 0.08)}" r="${r(h * 0.1)}"/><path d="M${r(x - h * 0.1)},${r(y - h * 0.05)} Q${r(x - h * 0.2)},${r(y - h * 0.6)} ${r(x + h * 0.2)},${r(y - h * 0.5)} Q${r(x + h * 0.1)},${r(y - h * 0.2)} ${r(x + h * 0.15)},${r(y - h * 0.05)}Z"/><path d="M${r(x + h * 0.44)},${r(y - h * 0.08)} l${r(h * 0.1)},${r(h * 0.03)} l${r(-h * 0.1)},${r(h * 0.03)}Z" fill="#ffb347"/></g>`;
}
function manger(x, base, h) {
  return `<g><path d="M${r(x - h * 0.6)},${r(base)} L${r(x - h * 0.4)},${r(base - h * 0.5)} M${r(x + h * 0.6)},${r(base)} L${r(x + h * 0.4)},${r(base - h * 0.5)} M${r(x - h * 0.6)},${r(base - h * 0.5)} L${r(x - h * 0.4)},${r(base)} M${r(x + h * 0.6)},${r(base - h * 0.5)} L${r(x + h * 0.4)},${r(base)}" stroke="#6b4423" stroke-width="${r(h * 0.06)}"/>
  <path d="M${r(x - h * 0.55)},${r(base - h * 0.55)} L${r(x + h * 0.55)},${r(base - h * 0.55)} L${r(x + h * 0.42)},${r(base - h * 0.3)} L${r(x - h * 0.42)},${r(base - h * 0.3)}Z" fill="#8a5a34"/>
  <path d="M${r(x - h * 0.55)},${r(base - h * 0.55)} q${r(h * 0.55)},${r(-h * 0.2)} ${r(h * 1.1)},0" fill="#e8c86a"/>
  <ellipse cx="${r(x)}" cy="${r(base - h * 0.62)}" rx="${r(h * 0.28)}" ry="${r(h * 0.12)}" fill="#fffaf0"/><circle cx="${r(x - h * 0.2)}" cy="${r(base - h * 0.66)}" r="${r(h * 0.09)}" fill="#f6d2b5"/>
  <circle cx="${r(x)}" cy="${r(base - h * 0.65)}" r="${r(h * 0.9)}" fill="url(#glow)" opacity=".8"/></g>`;
}
function sleigh(x, base, h) {
  return `<g><path d="M${r(x - h)},${r(base - h * 0.15)} H${r(x + h * 0.9)} q${r(h * 0.25)},0 ${r(h * 0.25)},${r(-h * 0.2)}" stroke="#d4af37" stroke-width="${r(h * 0.05)}" fill="none" stroke-linecap="round"/>
  <path d="M${r(x - h * 0.9)},${r(base - h * 0.25)} Q${r(x - h * 1.1)},${r(base - h * 0.9)} ${r(x - h * 0.7)},${r(base - h * 0.8)} L${r(x + h * 0.6)},${r(base - h * 0.55)} Q${r(x + h * 0.8)},${r(base - h * 0.3)} ${r(x + h * 0.5)},${r(base - h * 0.25)}Z" fill="#b5262b"/>
  ${present(x - h * 0.4, base - h * 0.75, h * 0.35, h * 0.3, '#2e7d4f', '#ffd84d')}${present(x - h * 0.05, base - h * 0.65, h * 0.3, h * 0.25, '#2f5da8', '#fff')}</g>`;
}
function candles(x, base, h) {
  let s = '';
  [-0.35, 0, 0.35].forEach((o, i) => {
    const ch = h * (0.6 + (i === 1 ? 0.25 : 0));
    s += `<rect x="${r(x + o * h - h * 0.07)}" y="${r(base - ch)}" width="${r(h * 0.14)}" height="${r(ch)}" rx="4" fill="#fbf3e2"/><path d="M${r(x + o * h)},${r(base - ch - h * 0.18)} q${r(h * 0.06)},${r(h * 0.1)} 0,${r(h * 0.16)} q${r(-h * 0.06)},${r(-h * 0.06)} 0,${r(-h * 0.16)}Z" fill="url(#fire)"/><circle cx="${r(x + o * h)}" cy="${r(base - ch - h * 0.1)}" r="${r(h * 0.35)}" fill="url(#glow)" opacity=".7"/>`;
  });
  return s + `<path d="M${r(x - h * 0.6)},${r(base)} q${r(h * 0.3)},${r(-h * 0.1)} ${r(h * 0.6)},0 t${r(h * 0.6)},0" stroke="#2e7d4f" stroke-width="${r(h * 0.08)}" fill="none"/>`;
}
function plateOfCookies(x, base, h) {
  let s = `<ellipse cx="${r(x)}" cy="${r(base - h * 0.08)}" rx="${r(h * 0.7)}" ry="${r(h * 0.14)}" fill="#fff" stroke="#c9d6ea" stroke-width="3"/>`;
  [[-0.3, 0.2], [0, 0.28], [0.3, 0.2], [-0.15, 0.4], [0.15, 0.4]].forEach(([dx, dy]) => (s += `<circle cx="${r(x + dx * h)}" cy="${r(base - dy * h)}" r="${r(h * 0.17)}" fill="#c98b4a"/><circle cx="${r(x + dx * h - h * 0.05)}" cy="${r(base - dy * h - h * 0.04)}" r="${r(h * 0.025)}" fill="#4a2c16"/><circle cx="${r(x + dx * h + h * 0.06)}" cy="${r(base - dy * h + h * 0.03)}" r="${r(h * 0.025)}" fill="#4a2c16"/>`));
  return s;
}
// After Santa's visit: crumbs, one bitten cookie, and an empty mug.
function emptyPlate(x, base, h) {
  let s = `<ellipse cx="${r(x)}" cy="${r(base - h * 0.08)}" rx="${r(h * 0.7)}" ry="${r(h * 0.14)}" fill="#fff" stroke="#c9d6ea" stroke-width="3"/>`;
  s += `<path d="M${r(x - h * 0.05)},${r(base - h * 0.1)} a${r(h * 0.17)},${r(h * 0.17)} 0 1 1 ${r(h * 0.3)},${r(-h * 0.08)} q${r(-h * 0.08)},${r(h * 0.02)} ${r(-h * 0.1)},${r(h * 0.1)} q${r(-h * 0.1)},${r(-h * 0.02)} ${r(-h * 0.2)},${r(-h * 0.02)}Z" fill="#c98b4a"/>`;
  for (const [dx, dy, rr] of [[-0.4, 0.08, 0.025], [-0.28, 0.12, 0.018], [-0.15, 0.05, 0.02], [0.32, 0.1, 0.022], [0.45, 0.06, 0.016], [-0.5, 0.13, 0.015], [0.1, 0.13, 0.018]])
    s += `<circle cx="${r(x + dx * h)}" cy="${r(base - dy * h)}" r="${r(h * rr)}" fill="#a86d35"/>`;
  s += `<g transform="translate(${r(x + h * 0.95)},0)"><rect x="${r(-h * 0.22)}" y="${r(base - h * 0.5)}" width="${r(h * 0.44)}" height="${r(h * 0.5)}" rx="${r(h * 0.06)}" fill="#c0392b"/><path d="M${r(h * 0.22)},${r(base - h * 0.4)} q${r(h * 0.18)},0 ${r(h * 0.18)},${r(h * 0.15)} t${r(-h * 0.18)},${r(h * 0.15)}" stroke="#c0392b" stroke-width="${r(h * 0.05)}" fill="none"/><ellipse cx="0" cy="${r(base - h * 0.5)}" rx="${r(h * 0.22)}" ry="${r(h * 0.045)}" fill="#7a2620"/></g>`;
  return s;
}
function cocoa(x, base, h) {
  return `<g><rect x="${r(x - h * 0.3)}" y="${r(base - h * 0.7)}" width="${r(h * 0.6)}" height="${r(h * 0.7)}" rx="${r(h * 0.08)}" fill="#c0392b"/><path d="M${r(x + h * 0.3)},${r(base - h * 0.55)} q${r(h * 0.25)},0 ${r(h * 0.25)},${r(h * 0.2)} t${r(-h * 0.25)},${r(h * 0.2)}" stroke="#c0392b" stroke-width="${r(h * 0.07)}" fill="none"/>
  <ellipse cx="${r(x)}" cy="${r(base - h * 0.7)}" rx="${r(h * 0.3)}" ry="${r(h * 0.06)}" fill="#5a3320"/><circle cx="${r(x - h * 0.1)}" cy="${r(base - h * 0.75)}" r="${r(h * 0.07)}" fill="#fff"/><circle cx="${r(x + h * 0.08)}" cy="${r(base - h * 0.77)}" r="${r(h * 0.07)}" fill="#fff"/>
  <path d="M${r(x - h * 0.1)},${r(base - h * 0.9)} q${r(-h * 0.1)},${r(-h * 0.15)} 0,${r(-h * 0.3)} M${r(x + h * 0.1)},${r(base - h * 0.9)} q${r(h * 0.1)},${r(-h * 0.15)} 0,${r(-h * 0.3)}" stroke="#fff" stroke-width="4" opacity=".6" fill="none"/></g>`;
}
function gingerbread(x, base, h) {
  const c = '#b9773e';
  return `<g><circle cx="${r(x)}" cy="${r(base - h * 0.82)}" r="${r(h * 0.18)}" fill="${c}"/><path d="M${r(x - h * 0.15)},${r(base - h * 0.65)} h${r(h * 0.3)} l${r(h * 0.25)},${r(h * 0.15)} l${r(-h * 0.05)},${r(h * 0.08)} l${r(-h * 0.2)},${r(-h * 0.06)} v${r(h * 0.15)} l${r(h * 0.15)},${r(h * 0.3)} l${r(-h * 0.1)},${r(h * 0.05)} l${r(-h * 0.15)},${r(-h * 0.25)} l${r(-h * 0.15)},${r(h * 0.25)} l${r(-h * 0.1)},${r(-h * 0.05)} l${r(h * 0.15)},${r(-h * 0.3)} v${r(-h * 0.15)} l${r(-h * 0.2)},${r(h * 0.06)} l${r(-h * 0.05)},${r(-h * 0.08)}Z" fill="${c}"/>
  <circle cx="${r(x - h * 0.06)}" cy="${r(base - h * 0.85)}" r="${r(h * 0.025)}" fill="#fff"/><circle cx="${r(x + h * 0.06)}" cy="${r(base - h * 0.85)}" r="${r(h * 0.025)}" fill="#fff"/><path d="M${r(x - h * 0.07)},${r(base - h * 0.77)} q${r(h * 0.07)},${r(h * 0.05)} ${r(h * 0.14)},0" stroke="#fff" stroke-width="3" fill="none"/>
  <circle cx="${r(x)}" cy="${r(base - h * 0.55)}" r="${r(h * 0.03)}" fill="#ff4d4d"/><circle cx="${r(x)}" cy="${r(base - h * 0.45)}" r="${r(h * 0.03)}" fill="#4dc36b"/></g>`;
}
function sled(x, base, h) {
  return `<g><rect x="${r(x - h * 0.6)}" y="${r(base - h * 0.35)}" width="${r(h * 1.2)}" height="${r(h * 0.12)}" rx="6" fill="#b5262b"/><path d="M${r(x - h * 0.65)},${r(base - h * 0.05)} H${r(x + h * 0.6)} q${r(h * 0.2)},0 ${r(h * 0.15)},${r(-h * 0.25)}" stroke="#555" stroke-width="${r(h * 0.04)}" fill="none"/><path d="M${r(x - h * 0.4)},${r(base - h * 0.23)} v${r(h * 0.18)} M${r(x + h * 0.4)},${r(base - h * 0.23)} v${r(h * 0.18)}" stroke="#555" stroke-width="${r(h * 0.04)}"/></g>`;
}
function piano(x, base, h) {
  return `<g><rect x="${r(x - h * 0.6)}" y="${r(base - h)}" width="${r(h * 1.2)}" height="${r(h * 0.7)}" rx="8" fill="#2b1a12"/><rect x="${r(x - h * 0.6)}" y="${r(base - h * 0.42)}" width="${r(h * 1.2)}" height="${r(h * 0.1)}" fill="#fff"/>
  ${Array.from({ length: 10 }, (_, i) => `<rect x="${r(x - h * 0.55 + i * h * 0.12)}" y="${r(base - h * 0.42)}" width="${r(h * 0.05)}" height="${r(h * 0.06)}" fill="#111"/>`).join('')}
  <rect x="${r(x - h * 0.55)}" y="${r(base - h * 0.32)}" width="${r(h * 0.08)}" height="${r(h * 0.32)}" fill="#2b1a12"/><rect x="${r(x + h * 0.47)}" y="${r(base - h * 0.32)}" width="${r(h * 0.08)}" height="${r(h * 0.32)}" fill="#2b1a12"/>${candles(x + h * 0.35, base - h, h * 0.25)}</g>`;
}
function books(x, base, h) {
  const cols = ['#2f5da8', '#c0392b', '#2e7d4f', '#d4af37'];
  return cols.map((c, i) => `<rect x="${r(x - h * 0.5)}" y="${r(base - (i + 1) * h * 0.18)}" width="${r(h * (1 - i * 0.08))}" height="${r(h * 0.16)}" rx="4" fill="${c}"/>`).join('');
}
function car(x, base, h) {
  return `<g><path d="M${r(x - h)},${r(base - h * 0.25)} V${r(base - h * 0.5)} Q${r(x - h * 0.9)},${r(base - h * 0.6)} ${r(x - h * 0.6)},${r(base - h * 0.6)} L${r(x - h * 0.4)},${r(base - h * 0.9)} H${r(x + h * 0.35)} L${r(x + h * 0.6)},${r(base - h * 0.6)} Q${r(x + h)},${r(base - h * 0.6)} ${r(x + h)},${r(base - h * 0.4)} V${r(base - h * 0.25)}Z" fill="#2f5da8"/>
  <path d="M${r(x - h * 0.35)},${r(base - h * 0.62)} L${r(x - h * 0.22)},${r(base - h * 0.84)} H${r(x + h * 0.3)} L${r(x + h * 0.48)},${r(base - h * 0.62)}Z" fill="#cfe6ff"/>
  <circle cx="${r(x - h * 0.55)}" cy="${r(base - h * 0.2)}" r="${r(h * 0.2)}" fill="#222"/><circle cx="${r(x + h * 0.55)}" cy="${r(base - h * 0.2)}" r="${r(h * 0.2)}" fill="#222"/>
  ${pine(x, base - h * 0.9, h * 0.5, '#1f6b3f', false)}</g>`;
}

// Draws one element; returns its SVG. `slot` gives x, ground base and scale.
function drawElement(name, slot, rand, ctx) {
  const { x, base, k } = slot;
  switch (name) {
    case 'christmas-tree': return tree(x, base, 520 * k);
    case 'presents': return present(x - 60 * k, base, 110 * k, 90 * k, '#c0392b', '#ffd84d') + present(x + 50 * k, base, 90 * k, 120 * k, '#2e7d4f', '#fff') + present(x - 5 * k, base, 70 * k, 60 * k, '#2f5da8', '#ff8ad8');
    case 'snowman': return snowman(x, base, 330 * k);
    case 'candles': return candles(x, base, 150 * k);
    case 'reindeer': return quadruped(x, base, 230 * k, '#8a5a34', { antlers: true, nose: rand() < 0.5 ? '#ff3b3b' : '#3b2414' });
    case 'sleigh': return sleigh(x, base, 200 * k);
    case 'santa': return santa(x, base, 380 * k, rand);
    case 'shepherd': return person(x, base, 360 * k, rand, { color: '#8a6d4a' }) + `<path d="M${r(x + 70 * k)},${r(base)} V${r(base - 400 * k)} q0,${r(-40 * k)} ${r(-30 * k)},${r(-40 * k)}" stroke="#6b4423" stroke-width="${r(9 * k)}" fill="none" stroke-linecap="round"/>`;
    case 'sheep': return quadruped(x, base, 150 * k, '#f5f2ea', { wool: true });
    case 'manger': return manger(x, base, 220 * k);
    case 'donkey': return quadruped(x, base, 220 * k, '#8f8a84', { ears: 'long' });
    case 'wise-man': return person(x, base, 380 * k, rand, { color: ['#6c3483', '#1f6f78', '#a04000'][Math.floor(rand() * 3)] }) + `<path d="M${r(x - 30 * k)},${r(base - 370 * k)} l${r(10 * k)},${r(-30 * k)} l${r(10 * k)},${r(18 * k)} l${r(10 * k)},${r(-24 * k)} l${r(10 * k)},${r(24 * k)} l${r(10 * k)},${r(-18 * k)} l${r(10 * k)},${r(30 * k)}Z" fill="#d4af37"/>`;
    case 'cookies': return plateOfCookies(x, base, 140 * k);
    case 'cocoa': return cocoa(x, base, 140 * k);
    case 'empty-plate': return emptyPlate(x - 40 * k, base, 140 * k);
    case 'dog': return pet(x, base, 150 * k, 'dog');
    case 'cat': return pet(x, base, 120 * k, 'cat');
    case 'child': return person(x, base, 260 * k, rand, { kind: 'child', hat: ctx.hats && rand() < 0.4 ? 'santa' : undefined });
    case 'adult': return person(x, base, 400 * k, rand);
    case 'grandparent': return person(x, base, 380 * k, rand, { kind: 'grandparent' });
    case 'family': return person(x - 120 * k, base, 400 * k, rand) + person(x + 120 * k, base, 380 * k, rand) + person(x, base, 250 * k, rand, { kind: 'child' });
    case 'house': return villageHouse(x - 150 * k, base, 300 * k, 220 * k, '#c46a4a', '#5b2d24', ctx.time !== 'day');
    case 'sled': return sled(x, base, 160 * k);
    case 'gingerbread': return gingerbread(x, base, 160 * k);
    case 'piano': return piano(x, base, 330 * k);
    case 'books': return books(x, base, 160 * k);
    case 'car': return car(x, base, 230 * k);
    case 'pine-trees': return pine(x - 90 * k, base, 380 * k) + pine(x + 90 * k, base, 300 * k);
    default: return '';
  }
}

const SIZE = { 'christmas-tree': 2, family: 2, sleigh: 2, piano: 1.6, house: 1.6, car: 1.6, 'pine-trees': 1.6, santa: 1.2, reindeer: 1.4, donkey: 1.3, snowman: 1.1 };

// ---------------------------------------------------------------- composition
export function normalizePlanScene(scene = {}) {
  const setting = SETTINGS.includes(scene.setting) ? scene.setting : 'snowy-night';
  const time = TIMES.includes(scene.timeOfDay) ? scene.timeOfDay : INDOOR.has(setting) ? 'night' : 'night';
  const mood = MOODS.includes(scene.mood) ? scene.mood : 'cozy';
  const elements = [...new Set((scene.elements || []).filter((e) => ELEMENTS.includes(e)))].slice(0, 6);
  if (!elements.length) elements.push(INDOOR.has(setting) ? 'christmas-tree' : 'star');
  return { setting, timeOfDay: time, mood, elements };
}

export function renderSceneLayers(sceneIn, seed = 'x') {
  const scene = normalizePlanScene(sceneIn);
  const rand = rng(`${seed}|${scene.setting}|${scene.elements.join(',')}`);
  const indoor = INDOOR.has(scene.setting);
  const time = scene.timeOfDay;
  const ctx = { time, hats: true };

  const bg = background(scene.setting, time, rand);
  let sky = '';
  let wall = '';
  const ground = [];
  for (const e of scene.elements) {
    if (SKY.has(e)) sky += skyElement(e, rand, indoor);
    else if (WALL.has(e)) wall += wallElement(e, indoor, rand);
    else ground.push(e);
  }
  // Spread ground elements across the frame, avoiding the busiest background spots.
  const baseY = indoor ? 940 : scene.setting === 'nativity-stable' ? 860 : 900;
  const total = ground.reduce((a, e) => a + (SIZE[e] || 1), 0);
  // Keep the living-room fireplace (left side) visible.
  const left = scene.setting === 'cozy-living-room' && ground.length < 4 ? 700 : 160;
  let cursor = left;
  const span = W - left - 160;
  let fg = '';
  ground.forEach((e, i) => {
    const w = ((SIZE[e] || 1) / Math.max(total, 1)) * span;
    const x = cursor + w / 2 + (rand() - 0.5) * w * 0.15;
    cursor += w;
    const depth = i % 2 ? -25 : 15;
    const k = Math.min(1.15, 0.85 + 0.6 / Math.max(ground.length, 1));
    fg += `<ellipse cx="${r(x)}" cy="${r(baseY + depth + 6)}" rx="${r(140 * k * (SIZE[e] || 1) * 0.7)}" ry="${r(14 * k)}" fill="#000" opacity=".14"/>`;
    fg += drawElement(e, { x, base: baseY + depth, k }, rand, ctx);
  });

  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs(time)}`;
  const moodTint = { reverent: '#ffe7a8', magical: '#b9a8ff', joyful: '#ffd0a8', peaceful: '#a8d8ff', cozy: '#ffcf8a', funny: '#ffe08a' }[scene.mood];
  return {
    scene,
    background: `${head}${bg}${wall}${sky}<rect width="${W}" height="${H}" fill="${moodTint}" opacity=".07"/></svg>`,
    characters: `${head}${fg}</svg>`,
    full: `${head}${bg}${wall}${sky}${fg}<rect width="${W}" height="${H}" fill="${moodTint}" opacity=".07"/><rect width="${W}" height="${H}" fill="url(#vignette)"/></svg>`,
  };
}

function skyElement(e, rand, indoor) {
  // Indoors, sky things appear in the window.
  const x = indoor ? 1450 : 300 + rand() * 1320;
  const y = indoor ? 270 : 150 + rand() * 160;
  const k = indoor ? 0.4 : 1;
  switch (e) {
    case 'star': return `<circle cx="${r(x)}" cy="${r(y)}" r="${r(220 * k)}" fill="url(#glow)"/>` + starShape(x, y, 60 * k, 24 * k, '#fff3b0');
    case 'moon': return `<circle cx="${r(x)}" cy="${r(y)}" r="${r(180 * k)}" fill="url(#glow)" opacity=".7"/><circle cx="${r(x)}" cy="${r(y)}" r="${r(70 * k)}" fill="#fff8dc"/>`;
    case 'angel': return angel(indoor ? 1450 : x, indoor ? 330 : y + 80, indoor ? 110 : 220);
    case 'dove': return dove(x, y + 40, 120 * k);
    default: return '';
  }
}
function wallElement(e, indoor, rand) {
  if (!indoor) {
    if (e === 'string-lights') return Array.from({ length: 30 }, (_, i) => `<circle cx="${40 + i * 64}" cy="${r(40 + Math.sin(i / 2) * 18)}" r="9" fill="${['#ff5e5e', '#ffd84d', '#5ee37a', '#5ec8ff'][i % 4]}"/>`).join('') + `<path d="M0,40 ${Array.from({ length: 31 }, (_, i) => `L${i * 64},${r(34 + Math.sin(i / 2) * 18)}`).join(' ')}" stroke="#234" stroke-width="3" fill="none"/>`;
    if (e === 'wreath') return wreath(1700, 160, 80);
    if (e === 'bells') return bells(220, 140, 90);
    return '';
  }
  switch (e) {
    case 'stockings': return [0, 1, 2, 3].map((i) => `<g transform="translate(${170 + i * 135},480)"><path d="M0,0 h50 v80 q0,30 30,30 h20 q20,0 20,22 q0,24 -24,24 h-56 q-40,0 -40,-40Z" fill="${CLOTH[i]}"/><rect x="-6" y="-14" width="62" height="26" rx="8" fill="#fff"/></g>`).join('');
    case 'wreath': return wreath(940, 220, 90);
    case 'string-lights': return Array.from({ length: 26 }, (_, i) => `<circle cx="${40 + i * 74}" cy="${r(70 + Math.sin(i / 1.6) * 22)}" r="10" fill="${['#ff5e5e', '#ffd84d', '#5ee37a', '#5ec8ff'][i % 4]}"/><circle cx="${40 + i * 74}" cy="${r(70 + Math.sin(i / 1.6) * 22)}" r="28" fill="url(#glow)" opacity=".5"/>`).join('');
    case 'bells': return bells(940, 120, 80);
    default: return '';
  }
}
function wreath(x, y, R) {
  let s = `<circle cx="${x}" cy="${y}" r="${R}" fill="none" stroke="#1f6b3f" stroke-width="${R * 0.45}"/>`;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    s += `<circle cx="${r(x + Math.cos(a) * R)}" cy="${r(y + Math.sin(a) * R)}" r="${R * 0.09}" fill="#c0392b"/>`;
  }
  return s + `<path d="M${x - R * 0.3},${y + R} l${R * 0.3},${-R * 0.25} l${R * 0.3},${R * 0.25} l-${R * 0.3},${R * 0.1}Z" fill="#c0392b"/>`;
}
function bells(x, y, h) {
  const bell = (bx, rot) => `<g transform="rotate(${rot} ${bx} ${y})"><path d="M${bx - h * 0.4},${y + h} Q${bx - h * 0.4},${y + h * 0.2} ${bx},${y + h * 0.15} Q${bx + h * 0.4},${y + h * 0.2} ${bx + h * 0.4},${y + h}Z" fill="#d4af37"/><circle cx="${bx}" cy="${y + h * 1.05}" r="${h * 0.1}" fill="#a8892b"/></g>`;
  return bell(x - h * 0.35, 12) + bell(x + h * 0.35, -12) + `<path d="M${x - h * 0.5},${y + h * 0.1} q${h * 0.5},${-h * 0.4} ${h},0" stroke="#c0392b" stroke-width="${h * 0.12}" fill="none"/>`;
}

// A transparent layer of snowflakes, taller than the frame so it can scroll.
export function snowLayerSvg(seed = 's', height = H * 2, count = 260) {
  const rand = rng(seed);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}">`;
  for (let i = 0; i < count; i++) s += `<circle cx="${r(rand() * W)}" cy="${r(rand() * height)}" r="${r(1.5 + rand() * 4.5)}" fill="#fff" opacity="${r(0.45 + rand() * 0.5)}"/>`;
  return s + `</svg>`;
}

// Title / caption card artwork used for intro, outro and family headings.
export function titleCardSvg({ title, subtitle = '', time = 'night', seed = 't' }) {
  const rand = rng(seed);
  let stars = '';
  for (let i = 0; i < 160; i++) stars += `<circle cx="${r(rand() * W)}" cy="${r(rand() * H)}" r="${r(0.8 + rand() * 2.2)}" fill="#fffbe8" opacity="${r(0.25 + rand() * 0.6)}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${defs(time)}<rect width="${W}" height="${H}" fill="url(#sky)"/>${stars}
  <circle cx="960" cy="250" r="260" fill="url(#glow)" opacity=".8"/>${starShape(960, 250, 70, 28, '#fff3b0')}
  ${snowHills(time, 960)}
  <text x="960" y="560" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="${title.length > 34 ? 72 : 96}" fill="#fffaf0" style="letter-spacing:1px">${esc(title)}</text>
  ${subtitle ? `<text x="960" y="650" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-style="italic" font-size="46" fill="#ffe8b0">${esc(subtitle)}</text>` : ''}
  <rect width="${W}" height="${H}" fill="url(#vignette)"/></svg>`;
}
