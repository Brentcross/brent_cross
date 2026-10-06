// Access control. Three kinds of visitor:
//   host   – created the event; holds a secret host key (stored only as a hash)
//   family – opened the invite link / QR code containing the event's family code
//   anyone with the share link – can watch and download the finished keepsake only
// Roles are remembered in signed, httpOnly cookies scoped per event.
import crypto from 'node:crypto';
import { config } from './config.js';
import { getEvent, sha256 } from './store.js';

const sign = (v) => crypto.createHmac('sha256', config.secret).update(v).digest('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req, res, name, value, maxAgeDays = 60) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeDays * 86400}${secure}`);
}

function readSigned(req, name) {
  const raw = parseCookies(req)[name];
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const value = raw.slice(0, i);
  return safeEq(sign(value), raw.slice(i + 1)) ? value : null;
}
const writeSigned = (req, res, name, value) => setCookie(req, res, name, `${value}.${sign(value)}`);

export function grantHost(req, res, ev) {
  // Bound to the current host key hash, so rotating the key logs out old sessions.
  writeSigned(req, res, `h_${ev.id}`, ev.hostKeyHash.slice(0, 16));
}
// Not tied to the invite code: rotating the invite stops new guests joining
// without signing out phones that are already in.
export function grantFamily(req, res, ev) {
  writeSigned(req, res, `f_${ev.id}`, `member-${ev.id}`);
}

export function checkHostKey(ev, key) {
  return Boolean(key) && safeEq(sha256(String(key)), ev.hostKeyHash);
}

export function roleFor(req, ev) {
  if (!ev) return null;
  if (readSigned(req, `h_${ev.id}`) === ev.hostKeyHash.slice(0, 16)) return 'host';
  if (readSigned(req, `f_${ev.id}`) === `member-${ev.id}`) return 'family';
  return null;
}

// A stable anonymous id per phone/tablet so guests can see their own submissions.
export function deviceId(req, res) {
  let id = readSigned(req, 'dev');
  if (!id) {
    id = crypto.randomBytes(12).toString('base64url');
    writeSigned(req, res, 'dev', id);
  }
  return id;
}

// Express middleware: loads the event and enforces a minimum role.
export function requireRole(min) {
  return (req, res, next) => {
    const ev = getEvent(req.params.id);
    if (!ev) return res.status(404).json({ error: 'This Christmas Eve could not be found.' });
    const role = roleFor(req, ev);
    if (!role || (min === 'host' && role !== 'host')) return res.status(403).json({ error: 'Please use the invite link from your host.' });
    req.ev = ev;
    req.role = role;
    next();
  };
}

export { safeEq };
