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

## For Unto Us (Christmas scavenger hunt race)

`star-hunt/` is a Christ-centered Christmas scavenger hunt, run as a race around the house. Its theme is Isaiah 9:6: every card a player finds adds the next phrase of the verse, until the whole verse is written at the manger. Each stop has a story, scriptures from the Bible and the Book of Mormon, a painting, and a task for the group.

Three screens share one live game:

- **Players** (`star-hunt/`) sign up on their phones as a solo player or a team (team name plus members), each with a 4-digit PIN. The PIN gets them back into their game later in the night or on another phone, and keeps others out. After the MC starts the hunt, each player solves a riddle, finds the hidden card, and scans its QR code (or types its code) to open that part of the story and a task. The next riddle unlocks after the task. Cards scanned too early are refused without giving anything away, and Herod's decoy cards send players back.
- **TV** (`star-hunt/tv.html`) shows a join QR code, the race standings, the verse being written, the clues the MC has opened (hiding spot and code), who reached the manger first, and everyone's gifts for the Savior.
- **MC** (`star-hunt/mc.html`, unlocked with the MC passphrase) starts the hunt and, for each clue, releases a hint, a stronger hint, a line for little ones, or the hiding spot and code, whenever people are stuck. Players never see any of these until the MC releases them. The MC also resets forgotten player PINs, removes players, and clears or restarts the game.

`star-hunt/print.html` (also unlocked with the MC passphrase) prints the QR cards and the answer key.

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

### The hunt is sealed

The repo is public, so the hunt's secrets (card codes, hiding spots, riddles, answers, hints) never appear in it in plain text.

- `hunt-private/hunt.json` is the plain hunt. It is git-ignored and never deployed. Its shape is `tools/fixtures/sample-hunt.json`.
- `star-hunt/hunt.sealed.js` is generated from it and committed. Only the title, intro, verse phrases and a few messages are readable. Each card's part opens only with that card's code, the first riddle opens only when the MC presses Start, and the full hunt (for the MC console and the print page) opens only with the MC passphrase.

```sh
node tools/seal-hunt.mjs new-passphrase          # make a strong MC passphrase; keep it somewhere safe
export STAR_HUNT_PASSPHRASE='...'                # the MC passphrase
node tools/seal-hunt.mjs seal --new-codes        # first time: new card codes, then seal (also stamps version.js)
node tools/seal-hunt.mjs seal                    # after editing hunt-private/hunt.json
node tools/seal-hunt.mjs seal --new-start-key    # after a rehearsal in which the MC pressed Start
node tools/seal-hunt.mjs unseal                  # recreate hunt-private/hunt.json on another computer
node tools/seal-hunt.mjs stamp                   # new cache-busting stamp after changing HTML, CSS or JS
```

`seal` refuses a weak passphrase, codes that are already public, and replacing a hunt sealed with a different passphrase (`--force`). `--new-codes` makes every printed card stop working, so print the cards again afterwards.

### Files

- `star-hunt/hunt.sealed.js` (generated) holds the sealed hunt, and `star-hunt/seal.js` opens it in the browser.
- `star-hunt/store.js` keeps the shared game state (Firebase REST and live updates, or demo mode).
- `star-hunt/version.js` (generated) holds the build stamp that every page adds to its files' URLs, so phones never mix old and new files.
- `star-hunt/css/` is the shared look; `star-hunt/fonts/` holds the self-hosted fonts and their OFL licenses.
- `star-hunt/art/` holds the paintings, courtesy of The Church of Jesus Christ of Latter-day Saints; `art/CREDITS.md` lists each one.
- `star-hunt/qrcode.js` is the [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) library (MIT).

Tests (they need `playwright`, and Chromium via `CHROMIUM` if Playwright's bundled browser isn't installed):

- `node tools/seal-test.mjs` checks the sealing: every card opens only its own part, wrong codes and passphrases open nothing, no secret text is readable in the sealed file, and the browser opens exactly what the tool sealed. Before deploying the real hunt, run it with `STAR_HUNT_PASSPHRASE` set and `--release`: it then also fails if the site still holds the sample hunt.
- `node tools/store-test.mjs` checks the game state, including two phones on one team and a phone waking from sleep, against a small stand-in for Firebase.
- `node tools/star-hunt-test.mjs` plays a full race against a local server on port 8080. It uses a small stand-in for Firebase, so it needs no account.
