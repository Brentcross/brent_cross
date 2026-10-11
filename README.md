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

## Follow the Star (Christmas scavenger hunt race)

`star-hunt/` is a Christ-centered Christmas scavenger hunt, run as a race around the house. It follows the Nativity from the prophecies to the manger, with scriptures from the Bible and the Book of Mormon and a painting or photo at every stop.

Three screens share one live game:

- **Players** (`star-hunt/`) sign up on their phones as a solo player or a team (team name plus members), each with a 4-digit PIN. The PIN gets them back into their game later in the night or on another phone, and keeps others out. After the MC starts the hunt, each player solves a clue, finds the hidden card, and scans its QR code (or types its code) to open that part of the story and a task. The next clue unlocks after the task. Cards scanned too early are refused without giving anything away, and Herod's decoy cards send players back.
- **TV** (`star-hunt/tv.html`) shows a join QR code, the race standings, the clues the MC has opened (hiding spot and code), who reached the manger first, and everyone's gifts for the Savior.
- **MC** (`star-hunt/mc.html`, protected by its own PIN) starts the hunt, opens clues one at a time when people are stuck (they then show on the TV and on the phones of anyone stuck there), resets forgotten player PINs, removes players, and clears or restarts the game.

`star-hunt/print.html` prints the QR cards and the answer key.

### Live game setup (Firebase, free)

Without setup the app runs in demo mode: everything stays in one browser, so you can try it with the MC, TV and a few player tabs on one computer. To play across phones:

1. Go to https://console.firebase.google.com, add a project (Analytics not needed).
2. Build > Realtime Database > Create database (any location, start in locked mode).
3. On the Rules tab, paste and publish:
   ```json
   { "rules": { "games": { "$game": { ".read": true, ".write": true } } } }
   ```
4. Copy the database address shown on the Data tab (like `https://your-project-default-rtdb.firebaseio.com`) into `firebaseUrl` in `star-hunt/config.js`, then deploy.

Change `gameId` in `config.js` to start a fresh game (for example each year). The rules let anyone with the address read and write the game, which is fine for a family party; PINs are stored hashed.

### Files

- `star-hunt/hunt.js` holds the hunt: clues, hiding spots, scriptures, tasks, pictures, and the code on each card. Give every station a new random code when you make your own hunt.
- `star-hunt/store.js` keeps the shared game state (Firebase REST and live updates, or demo mode).
- `star-hunt/style.css` is the shared look.
- `star-hunt/qrcode.js` is the [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) library (MIT).
- Pictures load from the main image of the English Wikipedia article named in `hunt.js` (public-domain paintings and free photos). Use `art: { src: 'images/file.jpg', credit }` for your own photo instead.

`node tools/star-hunt-test.mjs` plays a full race against a local server on port 8080: sign-up, PINs, the start, wrong-order and decoy cards, clues opened by the MC, a second phone signing in, the finish, PIN reset and a new game, plus demo mode. It uses a small stand-in for Firebase, so it needs no account. Set `CHROMIUM` to a Chromium path if Playwright's bundled browser isn't installed.
