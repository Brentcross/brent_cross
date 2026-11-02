# brent_cross
Hey guys! My name is Brent Cross. I live in Nampa Idaho. I am a full time baker. Graduating in about a year with a degree in software engineering. 

## Cube Trainer

A mobile-first Rubik's Cube trainer, installable as a full-screen web app. Everything is in `index.html` (no libraries), plus `manifest.webmanifest`, `sw.js` (offline cache) and `icons/`.

- Swipe a sticker to turn its layer, drag empty space to rotate the view, or use the 18 move buttons.
- Scramble (20 moves), Reset, Undo, Redo, Hint, copy/paste scrambles, 3D or flat net view.
- Timer starts on the first turn after a scramble and stops when solved. Best time and fewest moves are saved on the device.
- Solution mode walks through a layer-by-layer solve: white cross, white corners, middle layer, yellow cross, yellow edges, yellow corners placed, twist last corners.
- A self-test runs on load and prints its results to the browser console.

### Run locally

```sh
npx http-server -p 8080 -a 127.0.0.1 -c-1 .      # or: python3 -m http.server 8080 --bind 127.0.0.1
```

Open http://localhost:8080. The server listens only on this computer; to try the app on a phone, use the hosted copy (below). The service worker (offline mode) only runs over https or on localhost.

### Host for free

- GitHub Pages: push this repo, then go to Settings > Pages, choose "Deploy from a branch", branch `main`, folder `/ (root)`. The app is served at `https://<user>.github.io/<repo>/`.
- Netlify Drop: go to https://app.netlify.com/drop and drag this folder onto the page.

On the phone, open the URL and choose "Add to Home Screen" (Safari share menu, or the Chrome menu) to get the full-screen app.

### Dev tools

- `node tools/make-icons.mjs` regenerates the icons (needs `playwright`).
- `node tools/smoke-test.mjs` runs headless phone-viewport checks against a local server on port 8080: self-test, 300 solver runs, swipe gestures, timer, records, solution mode, paste, and layout in portrait and landscape.

After changing `index.html`, bump `VERSION` in `sw.js` so installed copies pick up the update.

### Daily reminder notifications

The **Remind** button turns on a daily push notification (10:30 AM by default, any time can be picked). It needs the app installed to the Home Screen on iPhone (iOS 16.4 or newer).

GitHub Pages only serves files, so the reminders come from a small Cloudflare Worker in `worker/` (free plan). The app sends it the phone's push subscription, the reminder time and the time zone; a cron trigger runs every 5 minutes and sends each reminder at its local time, daylight saving included. Pushes are encrypted and signed with Web Push standards (VAPID, aes128gcm) using only built-in WebCrypto.

One-time setup:

1. Make a free account at https://dash.cloudflare.com and open **Workers & Pages** once, so the account gets its `workers.dev` subdomain.
2. Create an API token: My Profile > API Tokens > Create Token > **Edit Cloudflare Workers** template.
3. Copy the **Account ID** (on the Workers & Pages overview page, right side).
4. In GitHub: Settings > Secrets and variables > Actions > New repository secret. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Run the **Deploy reminder worker** workflow (Actions tab). It creates the storage, deploys the Worker, creates the push signing key once, and prints the Worker's address.
6. Put that address in `REMINDER_API` near the REMINDERS section of `index.html`, bump `VERSION` in `sw.js`, and push.

`cd worker && npm ci && npm test` runs the Worker tests (payload encryption is checked by decrypting with the independent `http_ece` library).

## For Unto Us

The Christmas scavenger hunt moved to [Christmas2026](https://github.com/Brentcross/Christmas2026) and is now served at https://brentcross.github.io/Christmas2026/for-unto-us/.
