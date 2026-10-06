# Christmas Eve Story Machine

Throughout one family holiday evening, everyone — toddlers to grandparents — adds a **story**, a **drawing** or a **photo** from their phone. Each piece is turned into a short video segment as it arrives. At the end of the night the host presses **Compile**, then plays the finished keepsake as a live reveal on the TV. Everyone gets a private link to watch and download it afterward.

## Quick start

Requirements: Node.js 22.9+, `ffmpeg` on the PATH, and a serif/sans font (DejaVu works; it's preinstalled on most Linux distros).

```sh
cd christmas-story-machine
npm install
cp .env.example .env      # optional: add ANTHROPIC_API_KEY for Claude-written captions
npm start                 # http://localhost:3000
```

Open the page, create your Christmas Eve, and **save the host link** it gives you. The dashboard shows an invite QR code. Guests on the same Wi-Fi scan it (use the computer's local IP, e.g. `http://192.168.1.20:3000`, or set `BASE_URL`), with no app or account needed.

Docker:

```sh
docker build -t story-machine .
docker run -p 3000:3000 -v story-data:/data -e ANTHROPIC_API_KEY=... story-machine
```

## The evening, step by step

| Who | Where | What |
|---|---|---|
| Host | `/` | Creates the event, saves the host link. |
| Host | `/host/:id` | Invite QR and link, live list of everything shared, edit words, approve or leave pieces out, reorder, music and running order, **Compile**, share link. |
| Guests | invite link → `/e/:id` | Enter their name (and optionally age and family) once, then tap **Tell a story**, **Share a drawing** or **Share a photo**. They see the status of their own pieces. After the reveal, the keepsake appears here too. |
| Host | `/reveal/:id` | Full-screen reveal on the TV: 3-2-1 countdown, the video, narration read aloud, then a QR code so everyone can grab the share link. |
| Anyone with the link | `/s/:token` | Watch and download the finished video. |

## What happens to each contribution

**Text stories.** Claude reads the story and picks a style:
- **Animated scene.** Used for short stories (about 70 words or fewer) about one moment. An illustrated backdrop pushes in slowly, the characters sway and bob, and snow falls (or golden sparkles rise indoors).
- **Narrated Ken Burns slideshow.** Used for longer memories, stories with several moments or many people, and reverent stories. It has 2–6 illustrated scenes with slow pans and zooms and cross-dissolves between them.

The story is split into scenes. Each scene shows the contributor's own words, lightly tidied, so a child's story still sounds like the child. Pictures are composed from a **curated library of vector Christmas artwork**: 11 settings (living room, kitchen, nativity stable, winter village, church…) and about 35 elements (tree, presents, family, grandparent, snowman, reindeer, manger, angel, dog…). Claude only *chooses* from these lists and never draws freely, so every picture is gentle and predictable. With `PEXELS_API_KEY` set, slideshow scenes use stock photos instead.

**Drawings.** The uploaded file is stored **byte-for-byte as submitted**, with its SHA-256 recorded, and the host can download the original. In the video the artwork is placed on a background, scaled uniformly to fit. It is never cropped, filtered or recolored. The only motion is a barely-there camera push over the whole frame, and the caption sits below the artwork so it never covers it.

**Photos.** Also stored untouched. The video shows the whole photo (with a soft blurred fill behind portrait shots) with a slow Ken Burns move and a caption.

**Captions and narration.** If the contributor didn't write a caption, Claude writes a warm one. For drawings and photos it looks at a downscaled copy of the picture; set `AI_VISION=0` to stop this. Without an API key, hand-written template captions are used.

**Voice.** The live reveal reads narration aloud using the TV/laptop browser's own voice. To record a narrator into the exported file, set `OPENAI_API_KEY`.

**Music.** By default a gentle music-box *Silent Night* plays under the video. The tune is public domain and is synthesized by the app, so no audio files ship with it. The host can upload their own track or choose silence. Narration automatically ducks the music.

## Compilation

All finished segments are joined in submission order, or grouped by family with a title card for each family. The video opens with a title card (event name plus an optional subtitle) and closes with a "Merry Christmas" card. Every segment fades softly at its edges, and scenes within a story cross-dissolve. Segments are rendered as pieces arrive, so the end-of-night compile only stitches them together. In testing, a 20-piece, 2½-minute keepsake compiled in about 15 seconds.

Output is a 1280×720, 25 fps H.264/AAC MP4, set up for streaming and easy to download.

## Content guardrails

Young children will be watching, so there are several layers and nothing is left to chance:

1. **Claude's instructions** require warm, simple, all-ages writing. It must be reverent for sacred subjects and remembered loved ones, and must never be scary, sarcastic or romantic, mention brands, or spoil Santa. It must keep the contributor's voice and never invent facts about real people.
2. **Claude reviews every submission.** It flags anything a host would want to see first (profanity, cruelty, mature or frightening content, private information like addresses). Flagged pieces are **held**: they are still rendered, but they stay out of the keepsake until the host approves them.
3. **A local word filter** runs on everything guests type and everything the AI writes, even with no API key. AI text that fails it is replaced with a template line.
4. **Pictures for stories come only from the curated art library.** With stock photos turned on, searches are prefixed with "christmas" and use Pexels' safe filtering.
5. **The host has the final say.** The host can read and edit every word (including each scene's narration), approve, leave out, reorder or delete any piece, and preview every segment before the reveal. The host can also turn on **"Hold everything for my approval first."**
6. If Claude declines a request, the server-side fallback retries it on another model. Any remaining failure falls back to template text, so the evening never depends on the network.

## Privacy and access

- **Host**: holds a secret host key, stored only as a hash. The host link carries it in the URL fragment, which is never sent to the server's logs. It is swapped for an httpOnly signed cookie and removed from the address bar.
- **Family**: the invite link contains an unguessable family code. Opening it sets a signed cookie for that event only. Guests see only their own pieces, and they see the keepsake only after the host starts the reveal. The host can issue a new invite link to stop new joins; phones already joined keep working.
- **Share link**: an unguessable token that allows watching and downloading the final video, and nothing else. The host can replace it at any time, which deactivates the old link.
- All media is stored privately on the host's machine under `DATA_DIR` (directory mode 0700) and served only through these checks. Responses carry `noindex`, `no-referrer` and a strict Content-Security-Policy.
- On a public server, set `CREATE_PASSWORD` so strangers can't create events, and put the app behind HTTPS (set `TRUST_PROXY=1` behind a reverse proxy).

## Lots of phones at once

- Each phone saves a submission to an **outbox in the browser (IndexedDB)** before sending it. A drop in Wi-Fi or a busy server never loses a story; the phone retries with backoff, including after a reload.
- Each submission carries an idempotency key, so retries never create duplicates.
- Uploads stream to disk instead of memory. When too many uploads are in flight at once, the server answers `503 Retry-After` and phones retry automatically.
- Processing runs in a two-stage background queue: **words** (Claude, `AI_CONCURRENCY`) and **render** (ffmpeg, `RENDER_CONCURRENCY`). The queue persists across restarts and retries failures up to 3 times.

In a burst test, 80 simultaneous submissions from one network were all accepted in about 2 seconds with no duplicates. They rendered in the background at roughly 5 seconds per piece on a 4-core machine.

## Configuration

See [`.env.example`](.env.example). Everything is optional; with nothing set, the app runs fully offline with template captions and built-in artwork.

## Development

```sh
npm test                 # unit + API tests (no network needed)
npm run dev              # auto-restart on changes
BASE=http://localhost:3000 npm run e2e [screenshot-dir]   # full browser run: 3 phones → compile → reveal → share
```

Code map:

- `server/app.js`: routes, uploads, access checks
- `server/auth.js`: host / family / device cookies
- `server/queue.js`: two-stage job queue and compilation runner
- `server/pipeline.js`: contribution → segment, segments → keepsake
- `server/ai.js`: Claude prompts and schemas, offline story planner
- `server/guardrails.js`: word filters, template captions
- `server/art/scene.js`: the curated illustration library
- `server/media.js`: drawing/photo framing, caption overlays
- `server/render.js`: ffmpeg (Ken Burns, animated layers, joins, music mix)
- `server/music.js`: the synthesized *Silent Night* music box
- `public/`: the phone page, host dashboard, reveal screen and share page (plain HTML/CSS/JS, no build step)
