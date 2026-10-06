// Local, deterministic content guardrails. These run on everything a guest types
// and on everything the AI writes, whether or not Claude is configured, so the
// reveal never contains a surprise. Anything that trips a check is held for the
// host to look at rather than silently dropped.

// Words that should never appear in AI-written narration for this audience, and
// that put a guest submission on hold for the host to review. Kept deliberately
// short and unambiguous so ordinary family stories ("the turkey was killer!")
// are not flagged; Claude's review handles nuance when it is enabled.
const BLOCKED = [
  'fuck', 'shit', 'bitch', 'bastard', 'cunt', 'whore', 'slut',
  'nigger', 'nigga', 'faggot', 'retard', 'porn', 'sex', 'sexy', 'naked', 'nude',
  'rape', 'suicide', 'murder', 'kill yourself', 'kys', 'cocaine', 'heroin', 'meth',
];

// Things AI narration must never say even if a guest did (e.g. spoiling the
// magic for little ones). Guests can still write it; the host sees a flag.
const NARRATION_ONLY = ['gun', 'blood', 'gore', 'drunk', 'beer', 'vodka', 'whiskey', 'hate', 'stupid', 'ugly',
  'santa is not real', "santa isn't real", 'santa is fake', 'santa is your parents'];

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[@4]/g, 'a')
    .replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[$5]/g, 's');

function hits(text, list) {
  const t = ` ${norm(text).replace(/[^a-z' ]+/g, ' ')} `;
  return list.filter((w) => t.includes(` ${w} `) || t.includes(` ${w}s `) || t.includes(` ${w}ed `) || t.includes(` ${w}ing `));
}

// Review a guest's own words. Returns { ok, reasons }.
export function reviewGuestText(...texts) {
  const found = hits(texts.join(' \n '), BLOCKED);
  return found.length ? { ok: false, reasons: [`contains: ${[...new Set(found)].join(', ')}`] } : { ok: true, reasons: [] };
}

// Check AI-written narration/captions. Returns true when safe to show.
export function isSafeNarration(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.length > 600) return false;
  if (/https?:\/\//i.test(text)) return false;
  return hits(text, [...BLOCKED, ...NARRATION_ONLY]).length === 0;
}

// Clean up a short line for on-screen display.
export function tidy(text, max = 220) {
  let s = String(text || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

// Warm, template captions used when Claude is unavailable or its output fails a check.
const pick = (arr, seed) => arr[Math.abs(hash(seed)) % arr.length];
function hash(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

export function fallbackCaption({ type, name, age, title, seed }) {
  const who = name ? name : 'someone special';
  const aged = age ? `, age ${age}` : '';
  const t = title ? `“${tidy(title, 60)}”` : null;
  const mid = age ? `${who} (age ${age})` : who; // for use mid-sentence
  const lines = {
    drawing: [
      `A Christmas picture drawn with love by ${who}${aged}.`,
      `${mid} made this one just for tonight.`,
      t ? `${t} — a masterpiece by ${who}${aged}.` : `Every line drawn with a happy heart, by ${who}${aged}.`,
      `Look closely — ${mid} put a little Christmas magic in every color.`,
    ],
    photo: [
      `A moment worth keeping, shared by ${who}.`,
      t ? `${t}, shared by ${who}.` : `Together is our favorite place to be. Shared by ${who}.`,
      `Smiles like these are the best gifts of all. Shared by ${who}.`,
    ],
    story: [
      `A Christmas story told by ${who}${aged}.`,
      t ? `${t}, a story by ${who}${aged}.` : `Gather close — ${mid} has a story for us.`,
    ],
  };
  return pick(lines[type] || lines.story, seed || `${name}${title}`);
}
