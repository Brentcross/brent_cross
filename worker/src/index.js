// Cube Trainer daily reminders.
//
// The app subscribes to Web Push and sends its subscription, the reminder
// time and its time zone here. A cron trigger runs every 5 minutes and pushes
// a notification to every subscription whose local time has just reached its
// reminder time. Pushes use VAPID (RFC 8292) and aes128gcm payload encryption
// (RFC 8291), built on WebCrypto, so the Worker has no dependencies.
//
// Storage: one KV key, "subs", holding { [endpoint]: { subscription, time, timeZone } }.

const SUBS_KEY = 'subs';
const MAX_SUBS = 25;
const WINDOW_MINUTES = 5; // must match the cron interval in wrangler.toml
// Only real browser push services, so this Worker can't be pointed elsewhere.
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
const MESSAGES = [
  'Time for your daily solve.',
  'Your cube is scrambled and waiting.',
  'Can you beat your best time today?',
  'One solve a day. Today is a good day for it.',
  'Ready for today\'s scramble?',
];

const te = new TextEncoder();

/* ------------------------------ base64url ------------------------------ */
export function b64uEncode(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/* ------------------------- payload encryption -------------------------- */
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// RFC 8291 / RFC 8188: one aes128gcm record addressed to the subscription's keys.
export async function encryptPayload(keys, plaintext) {
  const uaPublic = b64uDecode(keys.p256dh);
  const authSecret = b64uDecode(keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  const record = concat(plaintext, new Uint8Array([2])); // 0x02 marks the last record
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/* -------------------------------- VAPID -------------------------------- */
export async function loadVapid(env) {
  if (!env.VAPID_PRIVATE_JWK) throw new Error('VAPID_PRIVATE_JWK secret is not set');
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const privateKey = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const publicKey = b64uEncode(concat(new Uint8Array([4]), b64uDecode(jwk.x), b64uDecode(jwk.y)));
  return { privateKey, publicKey };
}

export async function vapidAuthorization(vapid, endpoint, subject, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = b64uEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  // Apple rejects tokens that live longer than an hour.
  const claims = b64uEncode(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 3300, sub: subject })));
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, te.encode(unsigned));
  return `vapid t=${unsigned}.${b64uEncode(sig)}, k=${vapid.publicKey}`;
}

export async function sendPush(env, vapid, subscription, message) {
  const body = await encryptPayload(subscription.keys, te.encode(JSON.stringify(message)));
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: '14400',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: await vapidAuthorization(vapid, subscription.endpoint, env.APP_URL),
    },
    body,
  });
  return res.status;
}

/* ------------------------------ scheduling ----------------------------- */
// Minutes since local midnight in the given IANA time zone.
export function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = t => Number(parts.find(p => p.type === t).value);
  return get('hour') * 60 + get('minute');
}
const timeToMinutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function isDue(entry, date) {
  const diff = (localMinutes(date, entry.timeZone) - timeToMinutes(entry.time) + 1440) % 1440;
  return diff < WINDOW_MINUTES;
}

function reminderMessage(date, url) {
  const day = Math.floor(date.getTime() / 86400000);
  return { title: 'Cube Trainer', body: MESSAGES[day % MESSAGES.length], url, tag: 'daily-reminder' };
}

async function readSubs(env) {
  return (await env.SUBS.get(SUBS_KEY, 'json')) || {};
}
async function writeSubs(env, subs) {
  await env.SUBS.put(SUBS_KEY, JSON.stringify(subs));
}

export async function sendDueReminders(env, date) {
  const subs = await readSubs(env);
  const due = Object.values(subs).filter(e => isDue(e, date));
  if (!due.length) return { sent: 0, removed: 0 };
  const vapid = await loadVapid(env);
  let sent = 0, removed = 0;
  for (const entry of due) {
    try {
      const status = await sendPush(env, vapid, entry.subscription, reminderMessage(date, env.APP_URL));
      if (status === 404 || status === 410) { delete subs[entry.subscription.endpoint]; removed++; }
      else if (status < 300) sent++;
      else console.log('push failed', status, new URL(entry.subscription.endpoint).host);
    } catch (err) {
      console.log('push error', err.message);
    }
  }
  if (removed) await writeSubs(env, subs);
  return { sent, removed };
}

/* -------------------------------- HTTP --------------------------------- */
function validSubscription(s) {
  if (!s || typeof s.endpoint !== 'string' || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return false;
  let url;
  try { url = new URL(s.endpoint); } catch { return false; }
  return url.protocol === 'https:' && PUSH_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
}
function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string'; } catch { return false; }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

async function handle(request, env) {
  const { pathname } = new URL(request.url);
  const json = (data, status = 200) => Response.json(data, { status });

  if (request.method === 'GET' && pathname === '/') return json({ ok: true, service: 'cube-reminders' });
  if (request.method === 'GET' && pathname === '/vapid-public-key') {
    try { return json({ publicKey: (await loadVapid(env)).publicKey }); }
    catch { return json({ error: 'Reminder server is still being set up' }, 503); }
  }
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (pathname === '/subscribe') {
    const { subscription, time, timeZone } = body;
    if (!validSubscription(subscription)) return json({ error: 'Invalid push subscription' }, 400);
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return json({ error: 'Time must be HH:MM' }, 400);
    if (!validTimeZone(timeZone)) return json({ error: 'Unknown time zone' }, 400);
    const subs = await readSubs(env);
    if (!subs[subscription.endpoint] && Object.keys(subs).length >= MAX_SUBS) return json({ error: 'Too many devices' }, 429);
    subs[subscription.endpoint] = {
      subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
      time, timeZone, updated: new Date().toISOString(),
    };
    await writeSubs(env, subs);
    return json({ ok: true, time, timeZone });
  }
  if (pathname === '/unsubscribe') {
    const subs = await readSubs(env);
    if (subs[body.endpoint]) { delete subs[body.endpoint]; await writeSubs(env, subs); }
    return json({ ok: true });
  }
  if (pathname === '/test') {
    const subs = await readSubs(env);
    const entry = subs[body.endpoint];
    if (!entry) return json({ error: 'This device has no reminder' }, 404);
    const status = await sendPush(env, await loadVapid(env), entry.subscription,
      { title: 'Cube Trainer', body: 'Test notification. Your daily reminder is set.', url: env.APP_URL, tag: 'test' });
    return json({ ok: status < 300, status }, status < 300 ? 200 : 502);
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try { res = await handle(request, env); }
    catch (err) { console.log('error', err.message); res = Response.json({ error: 'Server error' }, { status: 500 }); }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueReminders(env, new Date(event.scheduledTime)).then(r => {
      if (r.sent || r.removed) console.log('reminders', JSON.stringify(r));
    }));
  },
};
