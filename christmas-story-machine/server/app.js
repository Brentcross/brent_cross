import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { config } from './config.js';
import { createEvent, eventDir, getEvent, newId, updateEvent, getContribution, allEvents } from './store.js';
import { checkHostKey, deviceId, grantFamily, grantHost, requireRole, roleFor, safeEq } from './auth.js';
import { enqueue, queueStats, startCompile } from './queue.js';
import { orderedContributions } from './pipeline.js';
import { ttsEnabled } from './tts.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer', // keeps invite/share tokens out of Referer headers
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  const baseUrl = (req) => config.baseUrl || `${req.protocol}://${req.get('host')}`;
  const inviteUrl = (req, ev) => `${baseUrl(req)}/join/${ev.id}/${ev.familyCode}`;
  const shareUrl = (req, ev) => `${baseUrl(req)}/s/${ev.shareToken}`;
  const page = (name) => path.join(config.publicDir, name);

  // ------------------------------------------------------------------ pages
  app.get('/join/:id/:code', (req, res) => {
    const ev = getEvent(req.params.id);
    if (!ev || !safeEq(req.params.code, ev.familyCode)) return res.status(404).sendFile(page('notfound.html'));
    grantFamily(req, res, ev);
    deviceId(req, res);
    res.redirect(`/e/${ev.id}`);
  });
  app.get('/e/:id', (req, res) => res.sendFile(page('family.html')));
  app.get('/host/:id', (req, res) => res.sendFile(page('host.html')));
  app.get('/reveal/:id', (req, res) => res.sendFile(page('reveal.html')));
  app.get('/s/:token', (req, res) => {
    const ev = findByShare(req.params.token);
    if (!ev || !ev.compile?.output) return res.status(404).sendFile(page('notfound.html'));
    res.sendFile(page('share.html'));
  });
  app.use(express.static(config.publicDir, { index: 'index.html', maxAge: '5m' }));

  // ------------------------------------------------------------------ events
  const creations = new Map(); // ip -> [timestamps]
  app.post('/api/events', async (req, res) => {
    if (process.env.CREATE_PASSWORD && !safeEq(req.body?.password || '', process.env.CREATE_PASSWORD))
      return res.status(403).json({ error: 'That setup password is not right.' });
    const now = Date.now();
    const recent = (creations.get(req.ip) || []).filter((t) => now - t < 3600_000);
    if (recent.length >= 10) return res.status(429).json({ error: 'Too many new events from here; try again later.' });
    creations.set(req.ip, [...recent, now]);
    const hostKey = crypto.randomBytes(18).toString('base64url');
    const name = clean(req.body?.name, 60) || 'Our Christmas Eve';
    const ev = await createEvent({ name, hostKey });
    grantHost(req, res, ev);
    grantFamily(req, res, ev);
    deviceId(req, res);
    res.json({ id: ev.id, hostKey, hostUrl: `${baseUrl(req)}/host/${ev.id}#key=${hostKey}`, inviteUrl: inviteUrl(req, ev) });
  });

  // The host page sends the key from the URL fragment (never logged by servers).
  app.post('/api/e/:id/host-login', (req, res) => {
    const ev = getEvent(req.params.id);
    if (!ev || !checkHostKey(ev, req.body?.key)) return res.status(403).json({ error: 'That host link is not valid.' });
    grantHost(req, res, ev);
    grantFamily(req, res, ev);
    deviceId(req, res);
    res.json({ ok: true });
  });

  app.get('/api/e/:id/me', (req, res) => {
    const ev = getEvent(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Not found' });
    const role = roleFor(req, ev);
    if (!role) return res.json({ role: null });
    res.json({
      role,
      name: ev.name,
      revealed: Boolean(ev.revealedAt && ev.compile?.output),
      keepsakeVersion: ev.compile?.output?.version || 0,
    });
  });

  // ------------------------------------------------------------------ submissions
  let activeUploads = 0;
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = eventDir(req.params.id, 'incoming');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, `${Date.now()}-${newId(6)}`),
    }),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20, fieldSize: 16 * 1024 },
  });

  app.post(
    '/api/e/:id/contributions',
    requireRole('family'),
    (req, res, next) => {
      // Back-pressure: if too many uploads are in flight, ask the phone to retry shortly.
      if (activeUploads >= config.maxConcurrentUploads) {
        res.set('Retry-After', '3');
        return res.status(503).json({ error: 'Lots of stories arriving at once — retrying in a moment.', retry: true });
      }
      activeUploads++;
      let done = false;
      const release = () => {
        if (!done) {
          done = true;
          activeUploads--;
        }
      };
      res.on('finish', release);
      res.on('close', release);
      upload.single('file')(req, res, (err) => {
        if (err) {
          const tooBig = err.code === 'LIMIT_FILE_SIZE';
          return res.status(tooBig ? 413 : 400).json({ error: tooBig ? `That picture is too large (max ${Math.round(config.maxUploadBytes / 1048576)} MB).` : 'The upload did not come through. Please try again.' });
        }
        next();
      });
    },
    async (req, res) => {
      const tmp = req.file?.path;
      const discard = () => tmp && fsp.rm(tmp, { force: true });
      try {
        const b = req.body || {};
        const type = ['story', 'drawing', 'photo'].includes(b.type) ? b.type : null;
        if (!type) return discard(), res.status(400).json({ error: 'Unknown contribution type.' });
        const name = clean(b.name, 40);
        if (!name) return discard(), res.status(400).json({ error: 'Please tell us your name.' });
        const age = b.age === '' || b.age == null ? null : Number.parseInt(b.age, 10);
        if (age != null && !(age >= 0 && age <= 120)) return discard(), res.status(400).json({ error: 'Age should be a number.' });
        const text = type === 'story' ? cleanMultiline(b.text, config.maxStoryChars) : '';
        if (type === 'story' && text.length < 3) return discard(), res.status(400).json({ error: 'Please write a little story first.' });
        if (type !== 'story' && !tmp) return discard(), res.status(400).json({ error: 'Please choose a picture.' });
        let ext = null;
        if (tmp) {
          ext = await sniffImage(tmp);
          if (!ext) return discard(), res.status(415).json({ error: 'That file does not look like a picture. Please choose a photo.' });
        }
        const clientId = clean(b.clientId, 64) || null;
        const dev = deviceId(req, res);

        // Idempotent: a phone retrying the same submission gets the original back.
        if (clientId) {
          const existing = req.ev.contributions.find((c) => c.clientId === clientId && c.deviceId === dev);
          if (existing) return discard(), res.status(200).json(publicContribution(existing));
        }

        const id = newId(8);
        let fileMeta = null;
        if (tmp) {
          const dir = eventDir(req.ev.id, 'media', id);
          await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
          const name = `original.${ext}`;
          const sha = await hashFile(tmp);
          await fsp.rename(tmp, path.join(dir, name));
          fileMeta = { name, size: req.file.size, mime: req.file.mimetype, uploadedName: clean(req.file.originalname, 120), sha256: sha };
        }
        const c = await updateEvent(req.ev.id, (ev) => {
          ev.seq = (ev.seq || 0) + 1;
          const c = {
            id,
            seq: ev.seq,
            type,
            name,
            age,
            family: clean(b.family, 40),
            title: clean(b.title, 80),
            caption: clean(b.caption, 200),
            text,
            createdAt: new Date().toISOString(),
            deviceId: dev,
            clientId,
            status: 'queued',
            statusDetail: 'Waiting in line…',
            files: fileMeta ? { original: fileMeta } : {},
          };
          ev.contributions.push(c);
          return c;
        });
        enqueue(req.ev.id, id);
        res.status(201).json(publicContribution(c));
      } catch (err) {
        discard();
        console.error('[submit]', err);
        res.status(500).json({ error: 'Something went wrong saving that. Please try again.', retry: true });
      }
    },
  );

  // Contributions from this device (family view).
  app.get('/api/e/:id/mine', requireRole('family'), (req, res) => {
    const dev = deviceId(req, res);
    const mine = req.ev.contributions.filter((c) => c.deviceId === dev && !c.deleted).map(publicContribution);
    res.json({ items: mine, total: req.ev.contributions.filter((c) => !c.deleted).length });
  });

  app.delete('/api/e/:id/contributions/:cid', requireRole('family'), async (req, res) => {
    const c = getContribution(req.ev, req.params.cid);
    const dev = deviceId(req, res);
    if (!c || (req.role !== 'host' && c.deviceId !== dev)) return res.status(404).json({ error: 'Not found' });
    await updateEvent(req.ev.id, (ev) => {
      ev.contributions = ev.contributions.filter((x) => x.id !== c.id);
    });
    await fsp.rm(eventDir(req.ev.id, 'media', c.id), { recursive: true, force: true });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ host dashboard
  app.get('/api/e/:id/state', requireRole('host'), (req, res) => {
    const ev = req.ev;
    res.json({
      id: ev.id,
      name: ev.name,
      settings: ev.settings,
      inviteUrl: inviteUrl(req, ev),
      shareUrl: ev.compile?.output ? shareUrl(req, ev) : null,
      compile: ev.compile,
      revealedAt: ev.revealedAt || null,
      queue: queueStats(),
      ai: { claude: config.aiEnabled, voice: ttsEnabled(), stock: Boolean(config.pexelsKey) },
      contributions: ev.contributions.filter((c) => !c.deleted).map((c) => ({ ...publicContribution(c), host: hostFields(c) })),
      order: orderedContributions(ev).map((g) => ({ family: g.family, ids: g.items.map((c) => c.id) })),
    });
  });

  app.patch('/api/e/:id/contributions/:cid', requireRole('host'), async (req, res) => {
    const b = req.body || {};
    let rerender = false;
    const c = await updateEvent(req.ev.id, (ev) => {
      const c = getContribution(ev, req.params.cid);
      if (!c) return null;
      for (const k of ['name', 'family', 'title', 'caption']) {
        if (typeof b[k] === 'string') {
          const v = clean(b[k], k === 'caption' ? 200 : k === 'title' ? 80 : 40);
          if (v !== (c[k] || '')) {
            c[k] = v;
            rerender = true;
          }
        }
      }
      if ('age' in b) {
        const age = b.age === '' || b.age == null ? null : Number.parseInt(b.age, 10);
        if (age === null || (age >= 0 && age <= 120)) {
          c.age = age;
          rerender = true;
        }
      }
      if (Array.isArray(b.sceneNarrations) && c.plan) {
        b.sceneNarrations.slice(0, c.plan.scenes.length).forEach((t, i) => {
          const v = clean(t, 420);
          if (v && v !== c.plan.scenes[i].narration) {
            c.plan.scenes[i].narration = v;
            rerender = true;
          }
        });
        c.narration = c.plan.scenes.map((s) => s.narration).join(' ');
        c.planEdited = true;
      }
      if (typeof b.narration === 'string' && c.type !== 'story') {
        c.narration = clean(b.narration, 300);
        rerender = true;
      }
      if (typeof b.hidden === 'boolean') c.hidden = b.hidden;
      if (b.approved === true) {
        c.approved = true;
        c.review = { held: false, approvedAt: new Date().toISOString() };
      }
      return c;
    });
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (rerender && c.status !== 'queued') {
      await updateEvent(req.ev.id, (ev) => {
        const x = getContribution(ev, c.id);
        x.status = 'queued';
        x.statusDetail = 'Updating…';
        x.attempts = 0;
        x.keepWords = true;
      });
      enqueue(req.ev.id, c.id);
    }
    res.json({ ok: true });
  });

  app.post('/api/e/:id/contributions/:cid/retry', requireRole('host'), async (req, res) => {
    await updateEvent(req.ev.id, (ev) => {
      const c = getContribution(ev, req.params.cid);
      if (c) Object.assign(c, { status: 'queued', statusDetail: 'Retrying…', attempts: 0, error: null });
    });
    enqueue(req.ev.id, req.params.cid);
    res.json({ ok: true });
  });

  // Move a piece earlier/later in the running order.
  app.post('/api/e/:id/contributions/:cid/move', requireRole('host'), async (req, res) => {
    const dirn = req.body?.direction === 'up' ? -1 : 1;
    await updateEvent(req.ev.id, (ev) => {
      const list = ev.contributions.filter((c) => !c.deleted).sort((a, b) => (a.order ?? a.seq) - (b.order ?? b.seq));
      list.forEach((c, i) => (c.order = i));
      const i = list.findIndex((c) => c.id === req.params.cid);
      const j = i + dirn;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i].order, list[j].order] = [list[j].order, list[i].order];
    });
    res.json({ ok: true });
  });

  app.patch('/api/e/:id/settings', requireRole('host'), async (req, res) => {
    const b = req.body || {};
    await updateEvent(req.ev.id, (ev) => {
      if (typeof b.name === 'string' && clean(b.name, 60)) ev.name = clean(b.name, 60);
      if (['submitted', 'family'].includes(b.order)) ev.settings.order = b.order;
      if (['silent-night', 'none', 'custom'].includes(b.music)) ev.settings.music = b.music;
      if (typeof b.musicVolume === 'number') ev.settings.musicVolume = Math.min(1, Math.max(0, b.musicVolume));
      if (typeof b.dedication === 'string') ev.settings.dedication = clean(b.dedication, 80);
      if (typeof b.requireReview === 'boolean') ev.settings.requireReview = b.requireReview;
    });
    res.json({ ok: true });
  });

  const musicUpload = multer({ dest: path.join(config.dataDir, 'tmp'), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
  app.post('/api/e/:id/music', requireRole('host'), musicUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an audio file.' });
    const name = `custom-${newId(4)}`;
    const dir = eventDir(req.ev.id, 'music');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.rename(req.file.path, path.join(dir, name));
    await updateEvent(req.ev.id, (ev) => {
      ev.settings.customMusic = name;
      ev.settings.customMusicName = clean(req.file.originalname, 80);
      ev.settings.music = 'custom';
    });
    res.json({ ok: true });
  });

  app.post('/api/e/:id/compile', requireRole('host'), async (req, res) => {
    const started = await startCompile(req.ev.id);
    res.status(started ? 202 : 409).json({ ok: started });
  });

  app.post('/api/e/:id/reveal', requireRole('host'), async (req, res) => {
    if (!req.ev.compile?.output) return res.status(409).json({ error: 'Compile the keepsake first.' });
    await updateEvent(req.ev.id, (ev) => {
      ev.revealedAt = ev.revealedAt || new Date().toISOString();
    });
    res.json({ ok: true });
  });

  app.post('/api/e/:id/share/rotate', requireRole('host'), async (req, res) => {
    await updateEvent(req.ev.id, (ev) => {
      ev.shareToken = newId(18);
    });
    res.json({ shareUrl: shareUrl(req, getEvent(req.ev.id)) });
  });

  app.post('/api/e/:id/invite/rotate', requireRole('host'), async (req, res) => {
    await updateEvent(req.ev.id, (ev) => {
      ev.familyCode = newId(12);
    });
    res.json({ inviteUrl: inviteUrl(req, getEvent(req.ev.id)) });
  });

  app.get('/api/e/:id/qr.svg', requireRole('family'), async (req, res) => {
    const target = req.query.for === 'share' && req.ev.compile?.output ? shareUrl(req, req.ev) : inviteUrl(req, req.ev);
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, color: { dark: '#0b1634', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  });

  app.get('/api/e/:id/manifest', requireRole('family'), (req, res) => {
    const out = req.ev.compile?.output;
    if (!out || (req.role !== 'host' && !req.ev.revealedAt)) return res.status(404).json({ error: 'Not ready yet' });
    res.json({ name: req.ev.name, duration: out.duration, version: out.version, manifest: out.manifest, voiceBaked: ttsEnabled() });
  });

  // ------------------------------------------------------------------ media
  app.get('/api/e/:id/media/:cid/:kind', requireRole('family'), (req, res) => {
    const c = getContribution(req.ev, req.params.cid);
    if (!c) return res.status(404).end();
    if (req.role !== 'host' && c.deviceId !== deviceId(req, res)) return res.status(404).end();
    const dir = eventDir(req.ev.id, 'media', c.id);
    const file = { original: c.files?.original?.name, poster: 'poster.jpg', segment: 'segment.mp4' }[req.params.kind];
    if (!file) return res.status(404).end();
    res.set('Cache-Control', 'private, no-cache');
    if (req.params.kind === 'original' && req.query.download) res.attachment(`${c.name}-${c.type}-${c.seq}${path.extname(file)}`);
    res.sendFile(path.join(dir, file), (err) => err && !res.headersSent && res.status(404).end());
  });

  const sendKeepsake = (ev, kind, req, res) => {
    const out = ev.compile?.output;
    if (!out) return res.status(404).end();
    const file = eventDir(ev.id, 'output', kind === 'poster' ? 'poster.jpg' : 'keepsake.mp4');
    res.set('Cache-Control', 'private, max-age=60');
    if (req.query.download) res.attachment(`${ev.name.replace(/[^\w\- ]+/g, '').trim() || 'Christmas Eve'} keepsake.mp4`);
    res.sendFile(file, (err) => err && !res.headersSent && res.status(404).end());
  };
  app.get('/api/e/:id/keepsake.mp4', requireRole('family'), (req, res) => {
    if (req.role !== 'host' && !req.ev.revealedAt) return res.status(404).end();
    sendKeepsake(req.ev, 'video', req, res);
  });
  app.get('/api/e/:id/keepsake.jpg', requireRole('family'), (req, res) => {
    if (req.role !== 'host' && !req.ev.revealedAt) return res.status(404).end();
    sendKeepsake(req.ev, 'poster', req, res);
  });

  // Share link: watch + download only.
  app.get('/s/:token/info', (req, res) => {
    const ev = findByShare(req.params.token);
    if (!ev?.compile?.output) return res.status(404).json({ error: 'This link is no longer active.' });
    const o = ev.compile.output;
    res.json({ name: ev.name, duration: o.duration, pieces: o.pieces, builtAt: o.builtAt, version: o.version, dedication: ev.settings.dedication || '' });
  });
  app.get('/s/:token/video.mp4', (req, res) => {
    const ev = findByShare(req.params.token);
    if (!ev) return res.status(404).end();
    sendKeepsake(ev, 'video', req, res);
  });
  app.get('/s/:token/poster.jpg', (req, res) => {
    const ev = findByShare(req.params.token);
    if (!ev) return res.status(404).end();
    sendKeepsake(ev, 'poster', req, res);
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, queue: queueStats() }));

  app.use((err, req, res, next) => {
    console.error('[http]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' });
  });
  return app;
}

// ------------------------------------------------------------------ helpers
function findByShare(token) {
  if (!token || token.length < 16) return null;
  return allEvents().find((e) => safeEq(e.shareToken, token)) || null;
}

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanMultiline(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

async function sniffImage(file) {
  const fh = await fsp.open(file, 'r');
  const buf = Buffer.alloc(16);
  await fh.read(buf, 0, 16, 0);
  await fh.close();
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'gif';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.subarray(4, 8).toString() === 'ftyp') {
    const brand = buf.subarray(8, 12).toString();
    if (/^(avif|avis)$/.test(brand)) return 'avif';
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
  }
  if (buf.subarray(0, 2).toString() === 'II' || buf.subarray(0, 2).toString() === 'MM') return 'tif';
  return null;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function publicContribution(c) {
  return {
    id: c.id,
    seq: c.seq,
    type: c.type,
    name: c.name,
    age: c.age,
    family: c.family,
    title: c.title || c.autoTitle || '',
    caption: c.caption || c.autoCaption || '',
    createdAt: c.createdAt,
    status: c.status,
    statusDetail: c.statusDetail || '',
    hasPoster: c.status === 'ready',
  };
}
function hostFields(c) {
  return {
    text: c.text,
    userCaption: c.caption || '',
    narration: c.narration || '',
    style: c.style || null,
    styleReason: c.plan?.styleReason || '',
    scenes: c.plan?.scenes?.map((s) => ({ narration: s.narration, setting: s.setting, elements: s.elements })) || null,
    review: c.review || null,
    hidden: Boolean(c.hidden),
    error: c.error || null,
    duration: c.segment?.duration || null,
    original: c.files?.original ? { size: c.files.original.size, sha256: c.files.original.sha256 } : null,
    order: c.order ?? c.seq,
  };
}
