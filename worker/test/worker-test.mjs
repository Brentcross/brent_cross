// Tests for the reminder Worker, run in Node: `npm test`.
// Push payloads are decrypted with the independent http_ece library, and the
// VAPID token is verified with Node's own crypto, so the WebCrypto code is
// checked against other implementations rather than against itself.
import { createECDH, createPublicKey, verify, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import worker, { encryptPayload, loadVapid, vapidAuthorization, isDue, localMinutes, b64uEncode, b64uDecode, sendDueReminders } from '../src/index.js';
import { execFileSync } from 'node:child_process';

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

// A fake browser subscription with real keys.
function fakeSubscription(host = 'web.push.apple.com') {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  return { ua, auth, sub: { endpoint: `https://${host}/push/${randomBytes(8).toString('hex')}`, keys: { p256dh: b64uEncode(ua.getPublicKey()), auth: b64uEncode(auth) } } };
}

// 1. Payload encryption round trip.
{
  const { ua, auth, sub } = fakeSubscription();
  const msg = JSON.stringify({ title: 'Cube Trainer', body: 'Time for your daily solve.' });
  const body = await encryptPayload(sub.keys, new TextEncoder().encode(msg));
  const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: b64uEncode(auth) });
  check(plain.toString() === msg, 'aes128gcm payload decrypts with http_ece');
  check(body.length < 4096, `encrypted body fits one record (${body.length} bytes)`);
}

// 2. VAPID token.
const env = {
  VAPID_PRIVATE_JWK: execFileSync('node', ['scripts/gen-vapid.mjs']).toString(),
  APP_URL: 'https://brentcross.github.io/brent_cross/',
  ALLOWED_ORIGINS: 'https://brentcross.github.io,http://localhost:8080',
};
{
  const vapid = await loadVapid(env);
  check(b64uDecode(vapid.publicKey).length === 65 && b64uDecode(vapid.publicKey)[0] === 4, 'public key is a 65-byte uncompressed P-256 point');
  const now = Math.floor(Date.now() / 1000);
  const auth = await vapidAuthorization(vapid, 'https://web.push.apple.com/abc', env.APP_URL, now);
  const m = auth.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  check(!!m && m[4] === vapid.publicKey, 'Authorization header has the vapid t=..., k=... form');
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  const valid = verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64uDecode(m[3])));
  check(valid, 'ES256 signature verifies with Node crypto');
  const claims = JSON.parse(Buffer.from(b64uDecode(m[2])).toString());
  check(claims.aud === 'https://web.push.apple.com' && claims.exp - now <= 3600 && claims.sub === env.APP_URL, `claims ok ${JSON.stringify(claims)}`);
}

// 3. Timing, including daylight saving time in Idaho (America/Boise).
{
  const e = { time: '10:30', timeZone: 'America/Boise' };
  check(localMinutes(new Date('2026-10-31T16:30:00Z'), 'America/Boise') === 630, '16:30 UTC is 10:30 in Boise during daylight time');
  check(isDue(e, new Date('2026-10-31T16:30:00Z')), 'due at 10:30 MDT (Oct 31)');
  check(!isDue(e, new Date('2026-10-31T16:25:00Z')) && !isDue(e, new Date('2026-10-31T16:35:00Z')), 'not due at 10:25 or 10:35');
  check(isDue(e, new Date('2026-11-05T17:30:00Z')) && !isDue(e, new Date('2026-11-05T16:30:00Z')), 'due at 10:30 MST after the clocks change (Nov 5)');
  let ticks = 0;
  for (let t = Date.parse('2026-12-01T00:00:00Z'); t < Date.parse('2026-12-02T00:00:00Z'); t += 5 * 60000) if (isDue(e, new Date(t))) ticks++;
  check(ticks === 1, `exactly one 5-minute cron tick per day is due (${ticks})`);
  const odd = { time: '07:42', timeZone: 'America/New_York' };
  ticks = 0;
  for (let t = Date.parse('2026-12-01T00:00:00Z'); t < Date.parse('2026-12-02T00:00:00Z'); t += 5 * 60000) if (isDue(odd, new Date(t))) ticks++;
  check(ticks === 1, 'a time off the 5-minute grid is still sent exactly once');
}

// 4. HTTP endpoints and the cron job, with fake KV and a fake push service.
{
  const store = new Map();
  env.SUBS = { get: async (k, type) => (store.has(k) ? (type === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => { store.set(k, v); } };
  const pushes = [];
  let pushStatus = 201;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { pushes.push({ url, init }); return new Response(null, { status: pushStatus }); };
  const call = (method, path, body, origin = 'https://brentcross.github.io') =>
    worker.fetch(new Request('https://cube-reminders.example.workers.dev' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env);

  const pre = await call('OPTIONS', '/subscribe');
  check(pre.status === 204 && pre.headers.get('Access-Control-Allow-Origin') === 'https://brentcross.github.io', 'CORS preflight allows the app');
  const evil = await call('GET', '/vapid-public-key', null, 'https://evil.example');
  check(!evil.headers.get('Access-Control-Allow-Origin'), 'CORS does not allow other sites');
  const key = await (await call('GET', '/vapid-public-key')).json();
  check(key.publicKey === (await loadVapid(env)).publicKey, 'serves the VAPID public key');

  const { ua, auth, sub } = fakeSubscription();
  check((await call('POST', '/subscribe', { subscription: { ...sub, endpoint: 'https://evil.example/x' }, time: '10:30', timeZone: 'America/Boise' })).status === 400, 'rejects a non-push-service endpoint');
  check((await call('POST', '/subscribe', { subscription: sub, time: '25:00', timeZone: 'America/Boise' })).status === 400, 'rejects a bad time');
  check((await call('POST', '/subscribe', { subscription: sub, time: '10:30', timeZone: 'Mars/Base' })).status === 400, 'rejects a bad time zone');
  const ok = await call('POST', '/subscribe', { subscription: sub, time: '10:30', timeZone: 'America/Boise' });
  check(ok.status === 200, 'subscribes');
  const other = fakeSubscription('fcm.googleapis.com');
  await call('POST', '/subscribe', { subscription: other.sub, time: '18:00', timeZone: 'America/Boise' });

  const test = await call('POST', '/test', { endpoint: sub.endpoint });
  check(test.status === 200 && pushes.length === 1 && pushes[0].url === sub.endpoint, 'test push goes to that device only');
  const h = pushes[0].init.headers;
  check(h['Content-Encoding'] === 'aes128gcm' && h.TTL && h.Authorization.startsWith('vapid t='), 'push request headers');
  const testMsg = JSON.parse(ece.decrypt(Buffer.from(pushes[0].init.body), { version: 'aes128gcm', privateKey: ua, authSecret: b64uEncode(auth) }).toString());
  check(testMsg.title === 'Cube Trainer' && /Test/.test(testMsg.body), `test payload: ${JSON.stringify(testMsg)}`);
  check((await call('POST', '/test', { endpoint: 'https://web.push.apple.com/unknown' })).status === 404, 'test refuses unknown devices');

  pushes.length = 0;
  let r = await sendDueReminders(env, new Date('2026-10-31T16:25:00Z'));
  check(r.sent === 0 && pushes.length === 0, 'cron at 10:25 sends nothing');
  r = await sendDueReminders(env, new Date('2026-10-31T16:30:00Z'));
  check(r.sent === 1 && pushes.length === 1 && pushes[0].url === sub.endpoint, 'cron at 10:30 sends only the 10:30 reminder');
  const daily = JSON.parse(ece.decrypt(Buffer.from(pushes[0].init.body), { version: 'aes128gcm', privateKey: ua, authSecret: b64uEncode(auth) }).toString());
  check(daily.url === env.APP_URL && daily.body.length > 5, `daily payload: ${JSON.stringify(daily)}`);

  pushStatus = 410;
  r = await sendDueReminders(env, new Date('2026-11-01T17:30:00Z'));
  check(r.removed === 1 && !JSON.parse(store.get('subs'))[sub.endpoint] && JSON.parse(store.get('subs'))[other.sub.endpoint], 'expired subscription (410) is removed, others kept');
  const un = await call('POST', '/unsubscribe', { endpoint: other.sub.endpoint });
  check(un.status === 200 && Object.keys(JSON.parse(store.get('subs'))).length === 0, 'unsubscribe removes the device');

  // Scheduled handler wiring.
  pushStatus = 201;
  await call('POST', '/subscribe', { subscription: sub, time: '10:30', timeZone: 'America/Boise' });
  pushes.length = 0;
  const waits = [];
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-31T16:30:00Z') }, env, { waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  check(pushes.length === 1, 'scheduled() sends due reminders');

  const noKey = await worker.fetch(new Request('https://x/vapid-public-key'), { ...env, VAPID_PRIVATE_JWK: undefined });
  check(noKey.status === 503, 'reports 503 before the VAPID secret is set');
  globalThis.fetch = realFetch;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
