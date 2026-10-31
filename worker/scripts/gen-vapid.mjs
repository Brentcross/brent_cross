// Prints a new VAPID key pair as a private JWK (it includes the public x and y).
// The deploy workflow pipes this into `wrangler secret put VAPID_PRIVATE_JWK` once.
const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', privateKey);
process.stdout.write(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }));
