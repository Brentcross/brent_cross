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

## Follow the Star (Christmas scavenger hunt)

`star-hunt/` is a Christ-centered Christmas scavenger hunt played on phones around the house. It follows the Nativity from the prophecies to the manger, with scriptures from the Bible and the Book of Mormon at every stop.

- Tap Begin to get the first clue. Solve it, find the hidden star card, and scan its QR code with the phone camera (or type the code printed under it).
- Each card reveals that part of the story, the scriptures, a question to talk about, and a group challenge (put a verse in order, answer a question, or do something together). The next clue unlocks only after the challenge.
- A card scanned too early says "The star hasn't led you here yet" and doesn't give anything away. Herod's decoy cards send people back. Rescanning an old card shows it again.
- "Bring another phone" shows a QR code that catches another phone up to the same point.
- Progress is saved on each phone, so play in the browser (not "Add to Home Screen") so the camera links open in the same place.

Files:

- `star-hunt/hunt.js` holds the hunt: clues, hiding spots, scriptures, challenges, and the code on each card. Edit it to make your own hunt. Give every station a new random code.
- `star-hunt/print.html` prints the QR cards and the answer key for the hunt leader. Set the hunt address to where the app is hosted (it defaults to `https://brentcross.github.io/brent_cross/star-hunt/`).
- `star-hunt/qrcode.js` is the [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) library (MIT).

Anyone who reads `hunt.js` can see every code, so keep curious teenagers away from the source.

`node tools/star-hunt-test.mjs` plays the whole hunt headlessly against a local server on port 8080. It checks out-of-order, decoy, and unknown cards, the share link, and, if `jsqr` and `pngjs` are installed, decodes every printed QR. Set `CHROMIUM` to a Chromium path if Playwright's bundled browser isn't installed.
