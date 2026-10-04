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
npx http-server -p 8080 -c-1 .      # or: python3 -m http.server 8080
```

Open http://localhost:8080. To try it on a phone, open `http://<your-computer-ip>:8080` on the same Wi-Fi. The service worker (offline mode) only runs over https or on localhost.

### Host for free

- GitHub Pages: push this repo, then go to Settings > Pages, choose "Deploy from a branch", branch `main`, folder `/ (root)`. The app is served at `https://<user>.github.io/<repo>/`.
- Netlify Drop: go to https://app.netlify.com/drop and drag this folder onto the page.

On the phone, open the URL and choose "Add to Home Screen" (Safari share menu, or the Chrome menu) to get the full-screen app.

### Dev tools

- `node tools/make-icons.mjs` regenerates the icons (needs `playwright`).
- `node tools/smoke-test.mjs` runs headless phone-viewport checks against a local server on port 8080: self-test, 300 solver runs, swipe gestures, timer, records, solution mode, paste, and layout in portrait and landscape.

After changing `index.html`, bump `VERSION` in `sw.js` so installed copies pick up the update.
