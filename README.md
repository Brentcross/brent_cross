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

Open http://localhost:8080. The server listens only on this computer, because the repo folder also holds `hunt-private/` (see below); to try the app on a phone, use the hosted copy (below). The service worker (offline mode) only runs over https or on localhost.

### Host for free

- GitHub Pages: push this repo, then go to Settings > Pages, choose "Deploy from a branch", branch `main`, folder `/ (root)`. The app is served at `https://<user>.github.io/<repo>/`.
- Netlify Drop: go to https://app.netlify.com/drop and drag this folder onto the page (move `hunt-private/` out of it first, if it is there).

On the phone, open the URL and choose "Add to Home Screen" (Safari share menu, or the Chrome menu) to get the full-screen app.

### Dev tools

- `node tools/make-icons.mjs` regenerates the icons (needs `playwright`).
- `node tools/smoke-test.mjs` runs headless phone-viewport checks against a local server on port 8080: self-test, 300 solver runs, swipe gestures, timer, records, solution mode, paste, and layout in portrait and landscape.

After changing `index.html`, bump `VERSION` in `sw.js` so installed copies pick up the update.

## For Unto Us (Christmas scavenger hunt race)

`star-hunt/` is a Christ-centered Christmas scavenger hunt, run as a race around the house. Its theme is Isaiah 9:6: every card a player finds adds the next phrase of the verse, until the whole verse is written at the manger. Each stop has a story, scriptures from the Bible and the Book of Mormon, a painting, and a task for the group (put words in order, fill in a missing word, do something together, or, at the manger, add gifts for the Savior).

### How it works

Three screens share one live game, plus a print page:

- **Players** (`star-hunt/`) sign up on their phones as a solo player or a team (team name plus members), each with a 4-digit PIN. The PIN gets them back into their game later in the night or on another phone, and keeps others out. When the MC starts the hunt, every phone gets clue 1 at the same moment. Each player solves the riddle, finds the hidden card, and scans its QR code (or types its code) to open that part of the story and its task; the next riddle unlocks after the task. A card scanned too early is refused without giving anything away, Herod's decoy cards send players back, and rescanning an earlier card shows its story again.
- **TV** (`star-hunt/tv.html`) shows a join QR code, then the race standings, the verse being written, the clues the MC has opened (hiding spot and code), a log of which hints went out (never their text), who reached the manger first, the gifts for the Savior, and finally the whole verse.
- **MC console** (`star-hunt/mc.html`, unlocked with the MC passphrase) starts the hunt and shows who is stuck on which clue and for how long. Hints are MC-only: players never see a hint, the line for little ones, a hiding spot or a code until the MC releases it. For each clue the MC can release, independently and in any order, Hint 1 (a nudge), Hint 2 (a strong hint), the little-ones line, and Open (the hiding spot and code, which also go up on the TV). A release reaches every phone on that clue at once, and anyone who gets there later. Each clue's riddle, answer, solution and setup note sit in a fold for the MC's reference. The MC also resets forgotten PINs, removes players, clears everyone's progress (players stay) or starts a new game.
- **Print** (`star-hunt/print.html`, also unlocked with the MC passphrase) prints the QR cards (every card looks the same apart from its code, and the cards are sorted by code so the stack gives nothing away) and the answer key: for each station its phrase, riddle, answer, hiding spot, setup note, solution, hints, little-ones line and code, plus the decoys. Print the cards at 100% on card stock and test one with a phone before hiding them.

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

The repo is public, so the hunt's secrets (card codes, hiding spots, riddles, answers, solutions, hints, little-ones lines, setup notes, station stories) never appear in it in plain text.

- `hunt-private/hunt.json` is the plain hunt, the one file you edit. It is git-ignored and never deployed. Its shape is `tools/fixtures/sample-hunt.json`. Each station has its `code`, `phrase`, `title`, `clue` (the riddle that leads to it), `hide` (where the card goes), `setup` (notes for whoever hides the cards, such as what to do when the house has no such spot), `answer`, `solution`, `hint`, `hint2`, `kids`, and the player-facing `story`, `scriptures`, `ponder`, `challenge` and `art`. `decoys` lists Herod's cards with their codes, hiding spots and `why` (the wrong turn each one catches, shown to the MC only).
- **Warning:** `hunt-private/` holds the whole hunt in plain text: never serve it (keep any local server bound to 127.0.0.1, as below) and never commit it.
- `star-hunt/hunt.sealed.js` is generated from it and committed. Only the title, intro, verse phrases, cover art and a few messages (the decoy message, the "not yet" lines) are readable. Everything else is encrypted (AES-256-GCM): each station's part opens only with its card's code, the first riddle opens only with the key the MC console publishes when the MC presses Start, and the whole hunt (for the MC console and the print page) opens only with the MC passphrase.

**The MC passphrase** opens everything. Make a strong one with `node tools/seal-hunt.mjs new-passphrase`, keep it in a password manager, and give it only to the MC. Never commit it, never put it in a file in the repo, and never paste it into an issue or a chat. The tools read it from the `STAR_HUNT_PASSPHRASE` environment variable; `read -rs` keeps it out of your shell history:

```sh
read -rs STAR_HUNT_PASSPHRASE && export STAR_HUNT_PASSPHRASE   # type the passphrase, then Enter
```

**To edit the hunt:**

```sh
node tools/seal-hunt.mjs unseal          # recreate hunt-private/hunt.json from the sealed file (any computer)
# edit hunt-private/hunt.json
node tools/seal-hunt.mjs seal            # seal it again (keeps the card codes and the start key; stamps version.js)
node tools/seal-test.mjs                 # check the seal, then commit star-hunt/hunt.sealed.js and star-hunt/version.js
```

- **Card codes.** A plain `seal` keeps every code, so cards already printed (and cards players have already found) keep working. `seal --new-codes` gives every station and decoy a fresh 6-character code (no look-alike letters), writes them into `hunt-private/hunt.json`, and makes every printed card stop working: print the cards and the answer key again, and clear progress in the MC console. To add a station or decoy, either give it a new code yourself (6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, different from every other code) and print just its card, or leave its `code` out and seal with `--new-codes`, then reprint every card.
- **Reprint the answer key** after any edit to riddles, hints, hiding spots or setup notes; the cards themselves only change when the codes do.
- **After a rehearsal** in which the MC pressed Start, seal with `--new-start-key` (the old key was readable in the database while the hunt ran), then press Start again on the night.
- `seal` refuses a weak passphrase, codes that are already public, and replacing a hunt sealed with a different passphrase (`--force`). `node tools/seal-hunt.mjs stamp` writes a new cache-busting stamp after changing HTML, CSS or JS without resealing.

### Files

- `star-hunt/index.html` (players), `tv.html`, `mc.html` and `print.html` are the pages.
- `star-hunt/hunt.sealed.js` (generated) holds the sealed hunt, and `star-hunt/seal.js` opens it in the browser.
- `star-hunt/store.js` keeps the shared game state (Firebase REST and live updates, or demo mode); `star-hunt/config.js` says where.
- `star-hunt/version.js` (generated) holds the build stamp that every page adds to its files' URLs, so phones never mix old and new files.
- `star-hunt/css/` is the shared look; `star-hunt/fonts/` holds the self-hosted fonts and their OFL licenses.
- `star-hunt/art/` holds the paintings, courtesy of The Church of Jesus Christ of Latter-day Saints, used under the Church's terms for personal, noncommercial use. `star-hunt/art/CREDITS.md` lists each painting, alphabetically by title, with its file, Gospel Media page and usage notice. The image files have random names, so neither the names nor the credits give away which painting belongs to which station.
- `star-hunt/qrcode.js` is the [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) library (MIT).

### Tests

The browser tests need `playwright` (plus `jsqr` and `pngjs` for the QR checks) importable from the repo root, for example a `node_modules` folder symlinked in while testing (it is git-ignored; never commit it), and Chromium via `CHROMIUM` if Playwright's bundled browser isn't installed. `star-hunt-test.mjs` also uses `pdfinfo` and `pdftoppm` (poppler).

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory .   # from the repo root, in another terminal
node tools/seal-test.mjs                               # the sealing (add STAR_HUNT_PASSPHRASE to check the real hunt too)
STAR_HUNT_RELEASE=1 node tools/seal-test.mjs           # before deploying (with STAR_HUNT_PASSPHRASE): also fails if the site holds the sample hunt
node tools/store-test.mjs                              # the game state, against a stand-in for Firebase
node tools/star-hunt-test.mjs [screenshot folder]      # the whole race, end to end (needs STAR_HUNT_PASSPHRASE)
```

- `seal-test.mjs` checks that every card opens only its own part, wrong codes and passphrases open nothing, no secret text is readable in the sealed file, and the browser opens exactly what the tool sealed.
- `store-test.mjs` checks the shared game state, including two phones on one team and a phone waking from sleep.
- `star-hunt-test.mjs` plays the whole race on the real sealed hunt, each screen in its own browser like separate devices, against a small in-memory stand-in for Firebase (it never touches the real database): MC unlock, sign-ups, Start, every station and task type, every kind of MC release, sign-in on another phone, PIN reset, the TV, the print page (every printed QR code is decoded), clear progress, new game and demo mode. It also fetches every file the site serves and fails if any of them contains a code, hiding spot, answer, solution, hint, little-ones line, setup note, riddle or station text, and checks at every step that no phone shows anything it hasn't earned or the MC hasn't released. Set `URL` if the server isn't on `http://localhost:8080/`.
