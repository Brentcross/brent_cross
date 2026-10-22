// Shared game state for the player, TV and MC screens. This is the data layer only: the hunt content
// lives sealed in hunt.sealed.js and is opened with seal.js (window.HuntSeal).
//
// The whole game is one small JSON tree at games/<gameId>:
//   meta: {
//     startedAt   server time the MC tapped Start (absent before the start)
//     startKey    base64 key that opens clue 1 in hunt.sealed.js; the MC publishes it at Start
//     release: {  what the MC has released, per clue number N, under the key "c<N>" (the letter keeps
//                 Firebase from turning the object into an array):
//       c3: { hint1, hint1At, hint2, hint2At, kids, kidsAt, open: { code, hide, title }, openAt }
//     }
//   }
//   players: { <id>: { name, team, members[], pinHash, createdAt,
//                      found[], solved[], gifts[], giftsAt, lastAt, clueAt, finishedAt } }
//     found    card codes scanned, one slot per station: found[i] is station i+1's code
//     solved   the same for tasks done: solved[i] is station i+1's code once its task is done (and its phrase of
//              the verse written)
//     clueAt   when they reached their current clue, i.e. their latest solve (absent on clue 1: use startedAt)
//     foundAt  when they reached their current station (their latest card found), for ties at a station
//     lastAt   their latest activity; finishedAt when the last task was done; giftsAt when gifts last changed
// Times are server timestamps (ms). Write them as StarStore.SERVER_TIME.
//
// Several phones can play for one player (a team), and a phone waking from sleep can act on an old copy of
// the tree before its live connection catches up. So progress is written one slot at a time (found/<i>,
// solved/<i>), never as a whole list: a slot can only ever hold that station's code, so a late or repeated
// write can't erase anything. Only the unbroken run of slots from station 1 counts. The first-time fields
// (startedAt, clueAt, foundAt, finishedAt) are decided against a fresh read from the server, not the local copy,
// and every progress write is checked against the server's startedAt before it is sent, so a phone that slept
// through "Clear progress" or a new Start can't write its old progress into the new run.
//
// Online mode talks to the Firebase Realtime Database REST API (live updates over EventSource), so no
// SDK is needed. The Wi-Fi at a party comes and goes, so:
//   - the live stream is started again when the browser gives up on it (an HTTP error or a captive Wi-Fi page
//     closes an EventSource for good), when it has delivered nothing for too long (Firebase sends a keep-alive
//     about every 30 s; a half-open stream after Wi-Fi roaming or sleep delivers nothing), when the browser comes
//     back online and when the page is shown again. A tab hidden for 30 s lets go of its stream (each scanned card
//     opens a new tab) and takes it back, with a full refresh, when it is shown.
//   - writes go through a small outbox: applied here at once, sent in order, and laid over every copy of the tree
//     the stream sends until the database says OK (so the screen never jumps back).
//     A player's save that fails is retried with a growing pause (and at once when the connection is back), and is
//     kept in this tab's sessionStorage, so a reload doesn't lose it. StarStore.pending counts the writes waiting.
//     The MC console's writes (start, releases, PIN, remove, clear, new game) are different: they are sent once and
//     never later, because by then the moment has passed (a Clear queued on an offline console would wipe the race
//     that started since). If one isn't saved, its promise rejects ('not-saved'), the screen goes back to what the
//     server has, and the MC presses again. Start is decided against the server when it goes out, so a second
//     Start only republishes the key.
// Demo mode (no firebaseUrl in config.js) keeps the tree in localStorage and syncs the tabs of one browser.
(function () {
  'use strict';
  const cfg = window.STAR_HUNT_CONFIG || {};
  const gameId = cfg.gameId || 'christmas';
  const firebaseUrl = (cfg.firebaseUrl || '').trim().replace(/\/+$/, '');
  const SERVER_TIME = { '.sv': 'timestamp' };

  let tree = null;           // latest known game tree (null until loaded), with this tab's unsaved writes laid over it
  let server = null;         // online: the tree as the stream last brought it, without them (to undo an MC write)
  let loaded = false;        // true once the whole tree has arrived (demo mode: at once)
  let connected = false;
  const listeners = [];

  // ---------- tree helpers ----------
  const split = path => String(path || '').split('/').filter(Boolean);
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

  // Mirror the database: server timestamps become numbers, empty objects and nulls vanish, and a list that
  // gained a named child (gifts/<key>) becomes an object, as it does in Firebase.
  function clean(v) {
    if (v && typeof v === 'object') {
      if (v['.sv'] === 'timestamp') return Date.now();
      const out = Array.isArray(v) && Object.keys(v).every(k => /^\d+$/.test(k)) ? [] : {};
      let any = false;
      for (const k of Object.keys(v)) {
        const c = clean(v[k]);
        if (c !== null) { out[k] = c; any = true; }
      }
      return any ? out : null;
    }
    return v === undefined ? null : v;
  }

  function setAt(root, path, value) {
    const parts = split(path);
    if (!parts.length) return clean(value);
    root = root && typeof root === 'object' ? root : {};
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    const v = clean(value);
    if (v === null) delete node[parts[parts.length - 1]];
    else node[parts[parts.length - 1]] = v;
    return clean(root);
  }

  function applyUpdate(root, path, obj) {
    for (const k of Object.keys(obj)) root = setAt(root, split(path).concat(split(k)).join('/'), obj[k]);
    return root;
  }

  function notify() { for (const fn of listeners) fn(tree, connected); }

  // ---------- demo mode (one browser) ----------
  const LOCAL_KEY = 'star-hunt:db:' + gameId;
  const channel = !firebaseUrl && 'BroadcastChannel' in window ? new BroadcastChannel(LOCAL_KEY) : null;
  function localRead() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch (e) { return {}; }
  }
  function localWrite(t) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(t || {})); } catch (e) {}
    if (channel) channel.postMessage(1);
  }
  function localRefresh() { tree = localRead(); notify(); }

  // ---------- online mode (Firebase Realtime Database) ----------
  const base = firebaseUrl + '/games/' + encodeURIComponent(gameId);
  const urlOf = path => base + (split(path).length ? '/' + split(path).map(encodeURIComponent).join('/') : '') + '.json';
  const TIMEOUT = 15000;     // a request on weak Wi-Fi can hang for minutes: give up on it after this and try again
  function request(path, init) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT) : 0;
    return fetch(urlOf(path), Object.assign({}, init, ctl ? { signal: ctl.signal } : {}))
      .then(r => r.text().then(text => ({ ok: r.ok, status: r.status, text })))
      .then(res => { clearTimeout(timer); return res; }, err => { clearTimeout(timer); throw err; });
  }
  // The answer is JSON from the database, not a Wi-Fi login page that happens to say 200.
  const json = text => { try { return { v: JSON.parse(text) }; } catch (e) { return null; } };
  // The value at path as the database holds it right now (demo mode: this browser's copy). Resolves to
  // undefined when it can't be read (offline), so callers fall back to the local tree.
  function fresh(path) {
    if (!firebaseUrl) return Promise.resolve(clone(getAt(localRead(), path)));
    return request(path, { cache: 'no-store' })
      .then(r => { const j = r.ok && json(r.text); return j ? clean(j.v) : undefined; }, () => undefined);
  }

  // The live stream. Every message it delivers (a keep-alive too) proves it is alive.
  const RETRY = [1000, 2000, 5000, 10000, 15000];
  const jitter = ms => Math.round(ms * (0.8 + Math.random() * 0.4));   // so 30 phones don't all retry at once
  const QUIET_MS = 75000;    // nothing at all for this long (not even a keep-alive): the stream is dead
  const SHOWN_MS = 30000;    // shown again after this long without a message: start a fresh stream at once
  const HIDDEN_MS = 30000;   // a tab hidden this long lets go of its stream
  let es = null, lastEventAt = 0, retries = 0, retryTimer = null, hiddenTimer = null, paused = false;
  function connect() {
    clearTimeout(retryTimer); retryTimer = null;
    if (es) es.close();
    paused = false;
    const me = es = new EventSource(base + '.json');
    lastEventAt = Date.now();
    const live = () => { if (es !== me) return false; lastEventAt = Date.now(); return true; };
    // A stream started while the old one looked fine leaves `connected` alone (no "Reconnecting…" flash),
    // unless it hasn't opened after 10 s.
    const slow = setTimeout(() => { if (es === me && me.readyState !== 1 && connected) { connected = false; notify(); } }, 10000);
    me.addEventListener('put', e => {
      if (!live()) return;
      const msg = JSON.parse(e.data);
      if (msg.path === '/') { server = clean(msg.data) || {}; received(clone(server)); loaded = true; }
      else { server = setAt(clone(server) || {}, msg.path, msg.data) || {}; received(setAt(tree || {}, msg.path, msg.data)); }
      retries = 0; connected = true; notify();
    });
    me.addEventListener('patch', e => {
      if (!live()) return;
      const msg = JSON.parse(e.data);
      server = applyUpdate(clone(server) || {}, msg.path, msg.data) || {};
      received(applyUpdate(tree || {}, msg.path, msg.data));
      notify();
    });
    me.addEventListener('keep-alive', live);
    me.addEventListener('cancel', () => { if (es === me) { connected = false; notify(); } });
    me.onopen = () => { if (!live()) return; clearTimeout(slow); connected = true; notify(); pump(true); };
    me.onerror = () => {
      if (es !== me) return;
      connected = false; notify();
      // After a network error the browser tries again by itself. Any other failure (an HTTP error status, a Wi-Fi
      // login page instead of the stream) closes it for good: start a new one after a pause.
      if (me.readyState === 2) { clearTimeout(retryTimer); retryTimer = setTimeout(connect, jitter(RETRY[Math.min(retries++, RETRY.length - 1)])); }
    };
  }
  const quietFor = ms => Date.now() - lastEventAt > ms;
  function watchConnection() {
    window.addEventListener('online', () => { if (!paused) connect(); pump(true); });
    window.addEventListener('pageshow', e => { if (e.persisted) { connect(); pump(true); } });
    const visibility = () => {
      clearTimeout(hiddenTimer);
      if (document.hidden) {
        hiddenTimer = setTimeout(() => {
          if (!document.hidden || !es) return;
          clearTimeout(retryTimer); es.close(); es = null; paused = true;   // quietly: no "Reconnecting…" on return
        }, HIDDEN_MS);
        return;
      }
      if (paused || !es || es.readyState === 2 || quietFor(SHOWN_MS)) connect();
      pump(true);
    };
    document.addEventListener('visibilitychange', visibility);
    if (document.hidden) visibility();          // opened in a background tab
    setInterval(() => { if (!paused && quietFor(QUIET_MS)) connect(); }, 15000);
  }

  // ---------- writes: apply here first so the screen updates at once, then save ----------
  // (Before the tree has loaded there is nothing to apply to: the write is only saved, and the live
  // connection brings it back with everything else.)
  function applyLocal(kind, path, value) {
    if (!loaded) return;
    if (kind === 'set') tree = setAt(clone(tree) || {}, path, value) || {};
    else tree = applyUpdate(clone(tree) || {}, path, value) || {};
    notify();
  }
  // Server timestamps in a value, filled in with this phone's clock (for the local copy only).
  const stamp = (v, at) => JSON.parse(JSON.stringify(v === undefined ? null : v), (k, x) => (x && typeof x === 'object' && x['.sv'] === 'timestamp' ? at : x));

  // The outbox (online mode). Each entry: { kind: 'set'|'update', path, value (as asked), local (as applied here),
  //   at, tries, pid (players/<pid>...), creates (addPlayer's PUT), run (progress writes: the meta.startedAt it was
  //   made in), decide ('find'|'solve'|'start': first-time fields to settle against a fresh read), n, last,
  //   once (an MC write: one try only, never kept across a reload), quiet (not shown here before it is saved) }.
  // Only `done` (the caller's promise), `sending` and `sent` (the body that went out) live outside sessionStorage.
  const QUEUE_KEY = 'star-hunt:outbox:' + gameId;
  const SLOW_MS = 4000;      // a save not confirmed after this long counts in StarStore.pending
  let queue = [], pumping = false, pumpTimer = null, shownPending = 0;
  function persist() {
    try {
      const keep = queue.filter(w => !w.once);
      if (!keep.length) { sessionStorage.removeItem(QUEUE_KEY); return; }
      sessionStorage.setItem(QUEUE_KEY, JSON.stringify(keep.map(w => ({ kind: w.kind, path: w.path, value: w.value, local: w.local,
        at: w.at, tries: w.tries, pid: w.pid, creates: w.creates, run: w.run, decide: w.decide, n: w.n, last: w.last }))));
    } catch (e) { /* storage blocked: the outbox still works until a reload */ }
  }
  // Only a player's own writes come back after a reload: progress (made in a run) and signing up. MC writes are never
  // kept, but an outbox saved by an earlier build of this file may hold one, such as a Clear made offline: that must
  // not go out now.
  function restore() {
    try {
      const q = JSON.parse(sessionStorage.getItem(QUEUE_KEY) || '[]');
      const mine = w => w && (w.kind === 'set' || w.kind === 'update') && typeof w.path === 'string' && !w.once &&
        /^players\/[^/]+/.test(w.path) && (w.run !== undefined || !!w.creates);
      if (Array.isArray(q)) queue = q.filter(mine)
        .map(w => Object.assign(w, { tries: Math.max(1, w.tries || 0) }));   // from before a reload: check it again
    } catch (e) { queue = []; }
  }
  const overlay = t => { for (const w of queue) if (!w.quiet) t = (w.kind === 'set' ? setAt(t, w.path, w.local) : applyUpdate(t, w.path, w.local)) || {}; return t; };
  // The writes waiting for the connection: all of them once one has failed or is slow, else 0.
  const pendingCount = () => (queue.some(w => w.tries > 0 || Date.now() - w.at >= SLOW_MS) ? queue.length : 0);
  function pendingChanged() { const n = pendingCount(); if (n !== shownPending) { shownPending = n; notify(); } }
  function settleWrite(w, err) {
    const d = w.done;
    w.done = null;
    if (d) err ? d.reject(err) : d.resolve();
  }
  // A write that must not be sent after all. A first try rejects with err.code; the stream then brings the truth.
  function drop(w, code) {
    queue = queue.filter(x => x !== w);
    settleWrite(w, code === 'stale-run' ? Object.assign(new Error('This phone is behind the game.'), { code })
      : code === 'no-player' ? Object.assign(new Error('There is no player ' + w.pid + ' in this game.'), { code }) : null);
  }
  // A copy of the tree just came from the server: drop what must no longer be sent (progress from an earlier run,
  // writes for a player who is gone), then lay the rest of the outbox over it, so the screen doesn't jump back.
  function received(t) {
    tree = t || {};
    if (!queue.length) return;
    const ps = tree.players || {}, at = metaOf(tree).startedAt || null, made = new Set(), n = queue.length;
    for (const w of queue.slice()) {
      if (w.creates) made.add(w.pid);
      if (w.sending || w.creates) continue;                 // in flight: its own check decides
      if (w.run !== undefined && w.run !== at) drop(w, 'stale-run');
      else if (w.pid && !made.has(w.pid) && !isPlayer(ps[w.pid])) drop(w, 'no-player');
    }
    if (queue.length !== n) persist();
    tree = overlay(tree);
    shownPending = pendingCount();                            // the caller notifies
  }
  // One try at one write: { ok } | { retry: err } (offline, timeout, 5xx, 429) | { drop: code } | { gone } (pruned).
  async function attempt(w) {
    let body = w.value, extra = null, shown = null;
    const start = w.decide === 'start';
    const needPlayer = !!w.pid && (!!w.decide || w.tries > 0), needRun = w.run !== undefined || start;
    if (needPlayer || needRun) {
      const [now, at] = await Promise.all([needPlayer ? fresh('players/' + w.pid) : null, needRun ? fresh('meta/startedAt') : null]);
      if (now === undefined || at === undefined) return { retry: new Error('Offline') };
      if (queue.indexOf(w) < 0) return { gone: true };
      if (w.run !== undefined && (at || null) !== w.run) return { drop: 'stale-run' };
      if (w.creates) { if (isPlayer(now)) return { ok: true }; }     // an earlier try reached the database after all
      else if (needPlayer && !isPlayer(now)) return { drop: 'no-player' };   // removed meanwhile: no ghost
      if (w.decide === 'find' && run(now.found).length < w.n) extra = { foundAt: SERVER_TIME };
      if (w.decide === 'solve' && run(now.solved).length < w.n) {
        extra = { clueAt: SERVER_TIME };
        if (w.last && !now.finishedAt) extra.finishedAt = SERVER_TIME;
      }
      // Start: only the first one sets startedAt, decided here as it goes out. A second Start (pressed again after a
      // lost answer, or from another console) only republishes the key, so the race clock and every phone's run stay.
      if (start) {
        body = { startKey: w.value.startKey };
        if (!at) extra = { startedAt: SERVER_TIME };
        else if (w.value.startedAt) shown = { startedAt: at };      // this copy was behind: show the real start
      }
      if (extra) { body = Object.assign({}, body, extra); shown = Object.assign(stamp(extra, Date.now()), shown); }
      if (shown) {                                            // show them here too, as the server will have them
        w.local = Object.assign({}, w.local, shown);
        if (loaded) { tree = applyUpdate(clone(tree) || {}, w.path, shown) || {}; notify(); }
      }
    }
    const method = w.kind === 'set' ? (w.value === null ? 'DELETE' : 'PUT') : 'PATCH';
    w.sent = { body };
    let r;
    try { r = await request(w.path, { method, body: method === 'DELETE' ? undefined : JSON.stringify(body) }); }
    catch (err) { return { retry: err }; }
    if (r.ok && json(r.text)) return { ok: true };
    const err = Object.assign(new Error('Save failed (' + r.status + ')'), { status: r.status });
    if (r.ok || r.status >= 500 || r.status === 429 || r.status === 408) return { retry: err };
    return { drop: 'refused', err };                          // e.g. the database rules said no: retrying won't help
  }
  // Does copy t hold value v at path (a server time matching any time)? An MC write whose answer was lost may have
  // reached the database all the same: then the stream has already brought it.
  function holds(t, path, v) {
    if (v && typeof v === 'object') {
      if (v['.sv'] === 'timestamp') return typeof getAt(t, path) === 'number';
      const ks = Object.keys(v);
      return ks.length ? ks.every(k => holds(t, path + '/' + k, v[k])) : getAt(t, path) == null;
    }
    return v == null ? getAt(t, path) == null : getAt(t, path) === v;
  }
  // MC writes that were not saved. They are never sent again: by the time the connection is back the moment has
  // passed. Their promises reject ('not-saved', so the MC is told and can press again), and the screen goes back
  // to what the server has at the paths they touched.
  function fail(ws, why, refused) {
    if (!ws.length) return;
    queue = queue.filter(x => ws.indexOf(x) < 0);
    for (const w of ws) {
      settleWrite(w, Object.assign(new Error(refused ? 'the database refused it (error ' + why.status + ').'
        : 'it wasn’t saved. Check the connection, then try again.'), { code: 'not-saved' }));
    }
    const shown = ws.filter(w => !w.quiet);
    if (loaded && shown.length) {
      let t = clone(tree) || {};
      for (const w of shown) {
        for (const k of w.kind === 'set' ? [''] : Object.keys(Object.assign({}, w.value, w.local))) {
          const p = split(w.path).concat(split(k)).join('/');
          t = setAt(t, p, clone(getAt(server, p))) || {};
        }
      }
      tree = overlay(t);
      notify();
    }
    console.warn('Not saved (an MC write is not retried):', why && why.message);
    window.dispatchEvent(new CustomEvent('star-store-error', { detail: why }));
  }
  // Send the outbox in order, one write at a time (a player's PUT must land before its PATCHes).
  async function pump(now) {
    if (!firebaseUrl || pumping) return;
    if (now !== true && pumpTimer) return;                    // waiting out a pause after a failure
    clearTimeout(pumpTimer); pumpTimer = null;
    pumping = true;
    try {
      while (queue.length) {
        const w = queue[0];
        w.sending = true;
        let res = await attempt(w);
        w.sending = false;
        if (res.gone) continue;
        if (w.once && res.retry && w.sent && loaded && holds(server, w.path, w.sent.body)) res = { ok: true };   // it landed
        if (w.once && (res.retry || res.drop === 'refused')) {    // an MC write: one try only
          fail([w], res.retry || res.err, !res.retry);
          persist(); pendingChanged();
          continue;
        }
        if (res.retry) {
          w.tries++;
          fail(queue.filter(x => x.once), res.retry);          // MC writes behind it can't go now, and won't later
          // Every write still waiting has had its try: let callers go on (the outbox keeps trying).
          const first = queue.filter(x => x.done);
          first.forEach(x => settleWrite(x));
          persist(); pendingChanged();
          console.warn('Not saved yet, will retry:', res.retry && res.retry.message);
          if (first.length) window.dispatchEvent(new CustomEvent('star-store-error', { detail: res.retry }));
          pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, jitter(RETRY[Math.min(w.tries - 1, RETRY.length - 1)]));
          break;
        }
        if (res.drop) {
          drop(w, res.drop);
          if (res.drop === 'refused') { console.error(res.err); window.dispatchEvent(new CustomEvent('star-store-error', { detail: res.err })); }
          else if (!paused) connect();                        // this phone is behind the game: catch up now
        } else {
          queue = queue.filter(x => x !== w);
          settleWrite(w);
        }
        persist(); pendingChanged();
      }
    } finally { pumping = false; }
  }
  function write(kind, path, value, opts) {
    if (!firebaseUrl) {
      applyLocal(kind, path, value);
      let t = localRead();
      t = kind === 'set' ? setAt(t, path, value) : applyUpdate(t, path, value);
      localWrite(t || {});
      return Promise.resolve();
    }
    const at = Date.now(), local = stamp(value, at);
    if (!(opts && opts.quiet)) applyLocal(kind, path, local);
    return new Promise((resolve, reject) => {
      const w = Object.assign({ kind, path: split(path).join('/'), value: value === undefined ? null : value, local, at, tries: 0 }, opts);
      const m = /^players\/([^/]+)/.exec(w.path);
      if (m) w.pid = m[1];
      if (m && kind === 'set' && split(w.path).length === 2 && value != null) w.creates = true;
      w.done = { resolve, reject };
      queue.push(w);
      persist();
      setTimeout(pendingChanged, SLOW_MS + 50);
      pump(true);
    });
  }
  // The run a progress write belongs to (see attempt): undefined in demo mode, where there is nothing to check.
  const runOpts = extra => (firebaseUrl ? Object.assign({ run: metaOf(tree).startedAt || null }, extra) : undefined);
  // An MC console write: one try, never queued for later (see fail). Its promise rejects 'not-saved' when it isn't saved.
  const once = extra => Object.assign({ once: true }, extra);

  // ---------- small helpers ----------
  const arr = v => (Array.isArray(v) ? v.filter(x => x != null) : v && typeof v === 'object' ? Object.values(v) : []);
  // found / solved: the unbroken run of slots from station 1 (Firebase may hand them back as an array or,
  // with a gap, as an object keyed "0", "1", ...).
  function run(v) {
    const out = [];
    if (v && typeof v === 'object') for (let i = 0; v[i] != null; i++) out.push(v[i]);
    return out;
  }
  function getAt(root, path) {
    let node = root;
    for (const k of split(path)) { if (!node || typeof node !== 'object') return null; node = node[k]; }
    return node === undefined ? null : node;
  }
  // A rejected promise with err.code, for the guards below.
  const refuse = (code, message) => Promise.reject(Object.assign(new Error(message), { code }));
  const NOT_LOADED = () => refuse('not-loaded', 'The game has not loaded yet.');
  const NO_PLAYER = id => refuse('no-player', 'There is no player ' + id + ' in this game.');

  function uid() {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    const r = new Uint8Array(10);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(r) : r.forEach((_, i) => { r[i] = Math.random() * 256; });
    r.forEach(b => { s += a[b % a.length]; });
    return s;
  }

  // PINs are stored hashed. crypto.subtle needs https or localhost; fall back to a
  // simple hash on plain http (testing on a home network).
  async function hashPin(salt, pin) {
    const text = gameId + ':' + salt + ':' + pin;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) { h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619); h2 = Math.imul(h2 + text.charCodeAt(i), 2246822519); }
    return 'f' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  }

  const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

  // ---------- reading the tree (pure: pass StarStore.tree) ----------
  const metaOf = t => (t && t.meta) || {};
  const started = t => !!metaOf(t).startedAt;
  const startKey = t => metaOf(t).startKey || null;

  // A real player has a name. A record without one is a leftover: a late save from a phone whose player the
  // MC had just removed. Those are skipped here (ghostIds lists them, removeGhosts deletes them).
  const isPlayer = r => !!(r && typeof r === 'object' && typeof r.name === 'string' && r.name);
  const players = t => {
    const p = (t && t.players) || {};
    return Object.keys(p).filter(id => isPlayer(p[id])).map(id => Object.assign({ id }, p[id], {
      found: run(p[id].found), solved: run(p[id].solved), gifts: arr(p[id].gifts), members: arr(p[id].members),
    }));
  };
  const ghostIds = t => Object.keys((t && t.players) || {}).filter(id => !isPlayer(t.players[id]));
  const player = (t, id) => (id && players(t).find(p => p.id === id)) || null;

  // Where a player is in the hunt. stationCount is HuntSeal.hunt.stationCount.
  //   { stage: 'clue', n, written, prevCode }  hunting for card n. The riddle for clue n is the nextClue of
  //                                            card prevCode's entry; on clue 1 prevCode is null and the
  //                                            riddle opens with the start key (HuntSeal.openStart).
  //   { stage: 'station', n, written, code }   at station n (card `code` found, its task not done yet)
  //   { stage: 'done', n, written }            every task done
  // written = phrases of the verse written so far (= solved.length).
  function progress(p, stationCount) {
    const found = run(p && p.found), solved = run(p && p.solved);
    const written = solved.length, last = found[found.length - 1];
    if (last && solved.indexOf(last) < 0) return { stage: 'station', n: found.length, written, code: last };
    if (written >= stationCount) return { stage: 'done', n: stationCount, written };
    const n = found.length + 1;
    return { stage: 'clue', n, written, prevCode: n > 1 ? found[n - 2] : null };
  }
  // When the player reached their current clue (ms), for "on clue 5 for 12 min".
  const clueSince = (t, p) => (p && p.clueAt) || metaOf(t).startedAt || null;

  // What scanning a card means for this player. entry is what HuntSeal.openCard returned (null if no card
  // has that code). Check started(tree) first: before the start every card is "not yet".
  //   'unknown'  no such card            'decoy'   one of Herod's cards
  //   'next'     the card they're hunting for: call findCard
  //   'almost'   the next card, but the task at their current station isn't done yet
  //   'current'  the station they're at now (task not done)      'recap'  a station they already did
  //   'notyet'   a later card (refuse without spoilers)
  function cardStatus(p, entry) {
    if (!entry) return 'unknown';
    if (entry.kind === 'decoy') return 'decoy';
    const found = run(p && p.found), solved = run(p && p.solved);
    const last = found[found.length - 1];
    if (found.indexOf(entry.code) >= 0) return entry.code === last && solved.indexOf(last) < 0 ? 'current' : 'recap';
    if (entry.n === found.length + 1) return last && solved.indexOf(last) < 0 ? 'almost' : 'next';
    return entry.n <= found.length ? 'recap' : 'notyet';
  }

  // Race order: finishers by finish time; then most phrases written; then anyone standing at a station
  // ahead of those still searching, and at the same station whoever found its card first; then whoever reached
  // their current clue first.
  function standings(t) {
    const foundAt = p => p.foundAt || Infinity;              // a record from before foundAt existed goes last
    return players(t).sort((a, b) => {
      if (a.finishedAt && b.finishedAt) return a.finishedAt - b.finishedAt;
      if (a.finishedAt || b.finishedAt) return a.finishedAt ? -1 : 1;
      if (b.solved.length !== a.solved.length) return b.solved.length - a.solved.length;
      if (b.found.length !== a.found.length) return b.found.length - a.found.length;
      if (a.found.length > a.solved.length) { const d = foundAt(a) - foundAt(b); if (d) return d; }
      return (a.clueAt || 0) - (b.clueAt || 0) || (a.createdAt || 0) - (b.createdAt || 0);
    });
  }
  // 1-based place in the standings. 0 if the player isn't in the game, and 0 for everyone until someone has
  // found a card (at the Start nobody is ahead, so nobody is "3rd of 3").
  const place = (t, id) => (players(t).some(p => p.found.length) ? standings(t).findIndex(p => p.id === id) + 1 : 0);
  // Finished players, first finisher first.
  const finishers = t => players(t).filter(p => p.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
  // The latest phrase written by anyone: { player, n, at } (player has written n phrases, the newest is
  // phrase n), or null before anyone has written one.
  function latestWrite(t) {
    let best = null;
    for (const p of players(t)) {
      if (p.solved.length && p.clueAt && (!best || p.clueAt > best.at)) best = { player: p, n: p.solved.length, at: p.clueAt };
    }
    return best;
  }
  // Every gift for the finale wall, oldest first: [{ text, name, id }].
  function allGifts(t) {
    const out = [];
    players(t).filter(p => p.gifts.length)
      .sort((a, b) => (a.giftsAt || a.lastAt || 0) - (b.giftsAt || b.lastAt || 0))
      .forEach(p => p.gifts.forEach(text => out.push({ text, name: p.name, id: p.id })));
    return out;
  }

  // ----- MC releases -----
  const RELEASE_KINDS = ['hint1', 'hint2', 'kids', 'open'];
  const releaseKey = n => 'c' + n;
  // What the MC has released for clue n: { hint1, hint1At, hint2, hint2At, kids, kidsAt, open: { code, hide, title },
  // openAt }, with only the released ones present ({} when nothing is).
  function releaseFor(t, n) {
    const r = (metaOf(t).release || {})[releaseKey(n)] || {};
    const out = {};
    for (const k of RELEASE_KINDS) if (r[k] != null) { out[k] = r[k]; out[k + 'At'] = r[k + 'At'] || null; }
    return out;
  }
  // Every clue with something released, by clue number: [{ n, hint1?, hint2?, kids?, open?, ...At }].
  function releases(t) {
    return Object.keys(metaOf(t).release || {})
      .map(k => /^c(\d+)$/.exec(k)).filter(Boolean)
      .map(m => Object.assign({ n: +m[1] }, releaseFor(t, +m[1])))
      .filter(r => RELEASE_KINDS.some(k => r[k] != null))
      .sort((a, b) => a.n - b.n);
  }
  // Clues the MC has opened (hiding spot + code), oldest opening first: [{ n, code, hide, title, at }].
  function openedClues(t) {
    return releases(t).filter(r => r.open && r.open.code)
      .map(r => ({ n: r.n, code: r.open.code, hide: r.open.hide || '', title: r.open.title || '', at: r.openAt || 0 }))
      .sort((a, b) => a.at - b.at || a.n - b.n);
  }
  // Time of the MC's latest release of any kind, or null.
  function lastReleaseAt(t) {
    let at = 0;
    for (const r of releases(t)) for (const k of RELEASE_KINDS) if ((r[k + 'At'] || 0) > at) at = r[k + 'At'];
    return at || null;
  }

  // ---------- writing (each returns the save promise; the local tree updates at once) ----------
  // Players' writes settle after their first try and are retried until saved. The MC's (setPin, removePlayer,
  // startHunt, release, releaseFromHunt, unrelease, clearProgress, removeGhosts, newGame) get one try: they resolve
  // when saved and reject 'not-saved' when not, and are never sent later.
  // A new solo player or team. Pass your own id (from uid()) to know it before the save; returns the id.
  async function addPlayer({ id, name, team, members, pin }) {
    id = id || uid();
    await write('set', 'players/' + id, {
      name, team: !!team, members: team ? arr(members) : [], pinHash: await hashPin(id, String(pin).trim()), createdAt: SERVER_TIME,
    });
    return id;
  }
  const checkPin = async (p, pin) => !!(p && p.pinHash) && (await hashPin(p.id, String(pin).trim())) === p.pinHash;
  // MC: reset a player's PIN.
  async function setPin(id, pin) {
    if (!loaded) return NOT_LOADED();
    if (!player(tree, id)) return NO_PLAYER(id);
    // Quiet: a PIN shows nowhere, so there is nothing to show before it is saved, nor to take back (and redraw) if not.
    return write('update', 'players/' + id, { pinHash: await hashPin(id, String(pin).trim()) }, once({ quiet: true }));
  }
  const removePlayer = id => write('set', 'players/' + id, null, once());

  // The station a card is: { code, n } from the entry HuntSeal.openCard returned. A bare code also works when
  // this page has already opened it (HuntSeal.peekCard) or, for solveCard, when the player has found it.
  function stationOf(x, p) {
    if (x && typeof x === 'object') return x.kind !== 'decoy' && x.code && x.n >= 1 ? { code: x.code, n: x.n } : null;
    if (typeof x !== 'string' || !x) return null;
    const H = window.HuntSeal, e = H && H.peekCard ? H.peekCard(x) : null;
    if (e) return stationOf(e, p);
    const i = p ? p.found.indexOf(x) : -1;
    return i >= 0 ? { code: x, n: i + 1 } : null;
  }
  // Slot writes for stations 1..n: found/<i> (and solved/<i> up to `solvedTo`). Rewriting the earlier slots
  // with the codes this phone knows is harmless (each slot only ever holds its own station's code) and mends
  // a slot whose save was lost.
  function slots(p, s, solvedTo) {
    const upd = {};
    for (let i = 0; i < s.n - 1; i++) upd['found/' + i] = p.found[i];
    upd['found/' + (s.n - 1)] = s.code;
    for (let i = 0; i < solvedTo; i++) upd['solved/' + i] = i === s.n - 1 ? s.code : p.found[i];
    return upd;
  }

  // The player scanned the card they were hunting for (cardStatus 'next'): record it.
  // Pass the entry from HuntSeal.openCard (a code it has opened works too). Rejects (err.code) with
  // 'not-loaded', 'no-player', 'bad-card' (not a station entry) or 'not-next' (an earlier card is missing).
  // The screen moves on at once. Before the save goes out, the server is asked whether this is still the same
  // run (else it rejects 'stale-run' and nothing is written) and whether a teammate found the card first (only
  // the first find sets foundAt).
  function findCard(id, card) {
    if (!loaded) return NOT_LOADED();
    const p = player(tree, id);
    if (!p) return NO_PLAYER(id);
    const s = stationOf(card, p);
    if (!s) return refuse('bad-card', 'findCard needs the station entry from HuntSeal.openCard.');
    if (p.found.length < s.n - 1) return refuse('not-next', 'Card ' + s.n + ' is not the next card for ' + p.name + '.');
    const upd = Object.assign(slots(p, s, 0), { lastAt: SERVER_TIME });
    if (!firebaseUrl && p.found.length < s.n) upd.foundAt = SERVER_TIME;
    return write('update', 'players/' + id, upd, runOpts({ decide: 'find', n: s.n }));
  }

  // The group task at a station is done: its phrase is written and the next clue is earned. Pass the entry
  // (or its code). clueAt, and finishedAt after the last station, are set only by the first phone to report
  // it: a phone acting on an old copy of the game can't move them. Rejects like findCard ('not-found' when
  // the card hasn't been found yet; 'stale-run' when the MC has cleared or restarted the hunt meanwhile;
  // 'no-player' when the player was removed meanwhile, and then nothing is written). Resolves without writing
  // when this phone already has it as solved. The screen moves on at once; the save waits in the outbox
  // (kept across a reload) until the server has been asked who was first.
  async function solveCard(id, card, stationCount) {
    if (!loaded) return NOT_LOADED();
    const p = player(tree, id);
    if (!p) return NO_PLAYER(id);
    const s = stationOf(card, p);
    if (!s) return refuse('bad-card', 'solveCard needs the station entry from HuntSeal.openCard.');
    if (p.found[s.n - 1] !== s.code) return refuse('not-found', 'Card ' + s.n + ' has not been found yet.');
    if (p.solved.length >= s.n) return;
    const upd = Object.assign(slots(p, s, s.n), { lastAt: SERVER_TIME });
    if (firebaseUrl) return write('update', 'players/' + id, upd, runOpts({ decide: 'solve', n: s.n, last: s.n >= stationCount }));
    const now = clone(getAt(localRead(), 'players/' + id));   // demo mode: this browser's copy decides
    if (!isPlayer(now)) return;
    if (run(now.solved).length < s.n) {
      upd.clueAt = SERVER_TIME;
      if (s.n >= stationCount && !now.finishedAt) upd.finishedAt = SERVER_TIME;
    }
    return write('update', 'players/' + id, upd);
  }

  // Replace the player's list of gifts for Him (the finale task).
  function setGifts(id, gifts) {
    if (!loaded) return NOT_LOADED();
    if (!player(tree, id)) return NO_PLAYER(id);
    return write('update', 'players/' + id, { gifts: arr(gifts), giftsAt: SERVER_TIME, lastAt: SERVER_TIME }, runOpts());
  }
  // Add one gift. Unlike setGifts, two phones of one team adding gifts at the same moment both keep theirs.
  function addGift(id, text) {
    if (!loaded) return NOT_LOADED();
    if (!player(tree, id)) return NO_PLAYER(id);
    text = String(text == null ? '' : text).trim();
    if (!text) return refuse('empty', 'The gift is empty.');
    const key = 'g' + Date.now().toString(36).padStart(9, '0') + uid().slice(0, 4);
    return write('update', 'players/' + id, { ['gifts/' + key]: text, giftsAt: SERVER_TIME, lastAt: SERVER_TIME }, runOpts());
  }

  // MC: start the hunt and publish the start key (from HuntSeal.openMC(...).startKey), so every phone opens
  // clue 1 at the same moment. It can be pressed again safely: if the hunt has already started (asked of the server
  // as the save goes out, not of this copy), it only republishes the key and startedAt stays. Online it needs the
  // server: when it can't be asked, nothing is written and the promise rejects 'not-saved'.
  function startHunt(key) {
    if (!key) return refuse('no-key', 'startHunt needs the start key');
    if (!loaded) return NOT_LOADED();
    const already = firebaseUrl ? started(tree) : !!getAt(localRead(), 'meta/startedAt');   // online: only what is shown at once
    return write('update', 'meta', already ? { startKey: key } : { startedAt: SERVER_TIME, startKey: key }, once({ decide: 'start' }));
  }
  // MC: release something for clue n to everyone on (or later reaching) clue n.
  // kind 'hint1' | 'hint2' | 'kids' takes the text; 'open' takes { code, hide, title } (once a clue is open its code
  // is public, so its station title may be too: the TV shows it).
  function release(n, kind, value) {
    if (RELEASE_KINDS.indexOf(kind) < 0) return Promise.reject(new Error('Unknown release: ' + kind));
    return write('update', 'meta/release/' + releaseKey(n), { [kind]: value, [kind + 'At']: SERVER_TIME }, once());
  }
  // MC: release straight from the unsealed hunt: hint1 <- station.hint, hint2 <- station.hint2,
  // kids <- station.kids, open <- { code: station.code, hide: station.hide, title: station.title }.
  function releaseFromHunt(hunt, n, kind) {
    const s = hunt && hunt.stations && hunt.stations[n - 1];
    if (!s) return Promise.reject(new Error('There is no clue ' + n));
    const value = kind === 'hint1' ? s.hint : kind === 'hint2' ? s.hint2 : kind === 'kids' ? s.kids
      : kind === 'open' ? { code: s.code, hide: s.hide || '', title: s.title || '' } : null;
    if (value == null || value === '' || (kind === 'open' && !value.code)) return Promise.reject(new Error('Clue ' + n + ' has no ' + kind));
    return release(n, kind, value);
  }
  // MC: take a release back, or every release for clue n when kind is left out.
  function unrelease(n, kind) {
    if (!kind) return write('set', 'meta/release/' + releaseKey(n), null, once());
    return write('update', 'meta/release/' + releaseKey(n), { [kind]: null, [kind + 'At']: null }, once());
  }
  // MC: back to "not started" with every player kept (progress, gifts and releases cleared, start key
  // withdrawn). It asks the server for the player list, so a player who joined a moment ago is cleared too,
  // and it deletes leftover records (ghostIds).
  async function clearProgress() {
    if (!loaded) return NOT_LOADED();
    const there = await fresh('players');
    const all = there === undefined ? (tree.players || {}) : (there || {});
    const upd = { 'meta/startedAt': null, 'meta/startKey': null, 'meta/release': null };
    for (const id of Object.keys(all)) {
      if (!isPlayer(all[id])) { upd['players/' + id] = null; continue; }
      for (const k of ['found', 'solved', 'gifts', 'giftsAt', 'lastAt', 'clueAt', 'foundAt', 'finishedAt']) upd['players/' + id + '/' + k] = null;
    }
    return write('update', '', upd, once());
  }
  // MC: delete leftover records (see ghostIds). clearProgress and newGame do this too.
  function removeGhosts() {
    const upd = {};
    for (const id of ghostIds(tree)) upd['players/' + id] = null;
    return Object.keys(upd).length ? write('update', '', upd, once()) : Promise.resolve();
  }
  // MC: remove every player and all progress.
  const newGame = () => write('update', '', { players: null, meta: null }, once());

  window.StarStore = {
    mode: firebaseUrl ? 'online' : 'demo',
    gameId,
    SERVER_TIME,
    get tree() { return tree; },
    get loaded() { return loaded; },
    get connected() { return connected; },
    // Writes this tab has made that the database hasn't confirmed yet, counted once one of them has failed or
    // been slow (0 otherwise, and always 0 in demo mode). Players' writes are retried until saved (MC writes get
    // one try); subscribers are told when it changes.
    get pending() { return firebaseUrl ? pendingCount() : 0; },
    subscribe(fn) { listeners.push(fn); if (tree) fn(tree, connected); },
    // low-level writes (prefer the helpers below). They are queued and retried like a player's progress, so the MC
    // console must not use them: its helpers below are sent once.
    set: (path, value) => write('set', path, value),
    update: (path, obj) => write('update', path, obj),
    remove: path => write('set', path, null),
    // helpers
    arr, uid, hashPin, ordinal,
    // reading
    meta: metaOf, started, startKey, players, player, ghostIds, progress, clueSince, cardStatus,
    standings, place, finishers, latestWrite, allGifts,
    RELEASE_KINDS, releaseKey, releaseFor, releases, openedClues, lastReleaseAt,
    // writing
    addPlayer, checkPin, setPin, removePlayer, findCard, solveCard, setGifts, addGift,
    startHunt, release, releaseFromHunt, unrelease, clearProgress, removeGhosts, newGame,
  };

  if (firebaseUrl) {
    restore();          // saves this tab made before a reload
    connect();
    watchConnection();
    pump(true);
  } else {
    connected = true; loaded = true;
    tree = localRead();
    window.addEventListener('storage', e => { if (e.key === LOCAL_KEY) localRefresh(); });
    if (channel) channel.onmessage = localRefresh;
  }
})();
