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
//     lastAt   their latest activity; finishedAt when the last task was done; giftsAt when gifts last changed
// Times are server timestamps (ms). Write them as StarStore.SERVER_TIME.
//
// Several phones can play for one player (a team), and a phone waking from sleep can act on an old copy of
// the tree before its live connection catches up. So progress is written one slot at a time (found/<i>,
// solved/<i>), never as a whole list: a slot can only ever hold that station's code, so a late or repeated
// write can't erase anything. Only the unbroken run of slots from station 1 counts. The first-time fields
// (startedAt, clueAt, finishedAt) are decided against a fresh read from the server, not the local copy.
//
// Online mode talks to the Firebase Realtime Database REST API (live updates over EventSource), so no
// SDK is needed. Demo mode (no firebaseUrl in config.js) keeps the tree in localStorage and syncs the
// tabs of one browser.
(function () {
  'use strict';
  const cfg = window.STAR_HUNT_CONFIG || {};
  const gameId = cfg.gameId || 'christmas';
  const firebaseUrl = (cfg.firebaseUrl || '').trim().replace(/\/+$/, '');
  const SERVER_TIME = { '.sv': 'timestamp' };

  let tree = null;           // latest known game tree (null until loaded)
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
  function remote(method, path, body) {
    return fetch(urlOf(path), { method, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(r => { if (!r.ok) throw new Error('Save failed (' + r.status + ')'); })
      .catch(err => { console.error(err); window.dispatchEvent(new CustomEvent('star-store-error', { detail: err })); });
  }
  // The value at path as the database holds it right now (demo mode: this browser's copy). Resolves to
  // undefined when it can't be read (offline), so callers fall back to the local tree.
  function fresh(path) {
    if (!firebaseUrl) return Promise.resolve(clone(getAt(localRead(), path)));
    return fetch(urlOf(path), { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : undefined))
      .then(v => (v === undefined ? undefined : clean(v)), () => undefined);
  }
  function connect() {
    const es = new EventSource(base + '.json');
    es.addEventListener('put', e => {
      const msg = JSON.parse(e.data);
      if (msg.path === '/') { tree = clean(msg.data) || {}; loaded = true; }
      else tree = setAt(tree || {}, msg.path, msg.data) || {};
      connected = true; notify();
    });
    es.addEventListener('patch', e => {
      const msg = JSON.parse(e.data);
      tree = applyUpdate(tree || {}, msg.path, msg.data) || {};
      notify();
    });
    es.addEventListener('cancel', () => { connected = false; notify(); });
    es.onerror = () => { connected = false; notify(); }; // EventSource reconnects by itself
    es.onopen = () => { connected = true; notify(); };
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
  function save(kind, path, value) {
    if (!firebaseUrl) {
      let t = localRead();
      t = kind === 'set' ? setAt(t, path, value) : applyUpdate(t, path, value);
      localWrite(t || {});
      return Promise.resolve();
    }
    return kind === 'set'
      ? (value === null ? remote('DELETE', path) : remote('PUT', path, value))
      : remote('PATCH', path, value);
  }
  function write(kind, path, value) {
    applyLocal(kind, path, value);
    return save(kind, path, value);
  }

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
  // ahead of those still searching; then whoever reached their current clue first.
  function standings(t) {
    return players(t).sort((a, b) => {
      if (a.finishedAt && b.finishedAt) return a.finishedAt - b.finishedAt;
      if (a.finishedAt || b.finishedAt) return a.finishedAt ? -1 : 1;
      if (b.solved.length !== a.solved.length) return b.solved.length - a.solved.length;
      if (b.found.length !== a.found.length) return b.found.length - a.found.length;
      return (a.clueAt || 0) - (b.clueAt || 0) || (a.createdAt || 0) - (b.createdAt || 0);
    });
  }
  // 1-based place in the standings (0 if the player isn't in the game).
  const place = (t, id) => standings(t).findIndex(p => p.id === id) + 1;
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
    return write('update', 'players/' + id, { pinHash: await hashPin(id, String(pin).trim()) });
  }
  const removePlayer = id => write('set', 'players/' + id, null);

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
  function findCard(id, card) {
    if (!loaded) return NOT_LOADED();
    const p = player(tree, id);
    if (!p) return NO_PLAYER(id);
    const s = stationOf(card, p);
    if (!s) return refuse('bad-card', 'findCard needs the station entry from HuntSeal.openCard.');
    if (p.found.length < s.n - 1) return refuse('not-next', 'Card ' + s.n + ' is not the next card for ' + p.name + '.');
    return write('update', 'players/' + id, Object.assign(slots(p, s, 0), { lastAt: SERVER_TIME }));
  }

  // The group task at a station is done: its phrase is written and the next clue is earned. Pass the entry
  // (or its code). clueAt, and finishedAt after the last station, are set only by the first phone to report
  // it: a phone acting on an old copy of the game can't move them. Rejects like findCard ('not-found' when
  // the card hasn't been found yet). Resolves without writing when this phone already has it as solved.
  async function solveCard(id, card, stationCount) {
    if (!loaded) return NOT_LOADED();
    const p = player(tree, id);
    if (!p) return NO_PLAYER(id);
    const s = stationOf(card, p);
    if (!s) return refuse('bad-card', 'solveCard needs the station entry from HuntSeal.openCard.');
    if (p.found[s.n - 1] !== s.code) return refuse('not-found', 'Card ' + s.n + ' has not been found yet.');
    if (p.solved.length >= s.n) return;
    const upd = Object.assign(slots(p, s, s.n), { lastAt: SERVER_TIME });
    applyLocal('update', 'players/' + id, upd);             // the screen moves on at once
    const now = await fresh('players/' + id);                // ...then the server decides who was first
    if (now === null || (now && !isPlayer(now))) return;     // removed meanwhile: don't bring a ghost back
    const solvedThere = now ? run(now.solved).length : p.solved.length;
    if (solvedThere < s.n) {
      upd.clueAt = SERVER_TIME;
      if (s.n >= stationCount && !(now ? now.finishedAt : p.finishedAt)) upd.finishedAt = SERVER_TIME;
    }
    return write('update', 'players/' + id, upd);
  }

  // Replace the player's list of gifts for Him (the finale task).
  function setGifts(id, gifts) {
    if (!loaded) return NOT_LOADED();
    if (!player(tree, id)) return NO_PLAYER(id);
    return write('update', 'players/' + id, { gifts: arr(gifts), giftsAt: SERVER_TIME, lastAt: SERVER_TIME });
  }
  // Add one gift. Unlike setGifts, two phones of one team adding gifts at the same moment both keep theirs.
  function addGift(id, text) {
    if (!loaded) return NOT_LOADED();
    if (!player(tree, id)) return NO_PLAYER(id);
    text = String(text == null ? '' : text).trim();
    if (!text) return refuse('empty', 'The gift is empty.');
    const key = 'g' + Date.now().toString(36).padStart(9, '0') + uid().slice(0, 4);
    return write('update', 'players/' + id, { ['gifts/' + key]: text, giftsAt: SERVER_TIME, lastAt: SERVER_TIME });
  }

  // MC: start the hunt and publish the start key (from HuntSeal.openMC(...).startKey), so every phone opens
  // clue 1 at the same moment. If the hunt has already started (asked of the server, not this copy), it only
  // republishes the key and startedAt stays.
  async function startHunt(key) {
    if (!key) return refuse('no-key', 'startHunt needs the start key');
    if (!loaded) return NOT_LOADED();
    const at = await fresh('meta/startedAt');
    const already = at === undefined ? started(tree) : !!at;
    return write('update', 'meta', already ? { startKey: key } : { startedAt: SERVER_TIME, startKey: key });
  }
  // MC: release something for clue n to everyone on (or later reaching) clue n.
  // kind 'hint1' | 'hint2' | 'kids' takes the text; 'open' takes { code, hide, title } (once a clue is open its code
  // is public, so its station title may be too: the TV shows it).
  function release(n, kind, value) {
    if (RELEASE_KINDS.indexOf(kind) < 0) return Promise.reject(new Error('Unknown release: ' + kind));
    return write('update', 'meta/release/' + releaseKey(n), { [kind]: value, [kind + 'At']: SERVER_TIME });
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
    if (!kind) return write('set', 'meta/release/' + releaseKey(n), null);
    return write('update', 'meta/release/' + releaseKey(n), { [kind]: null, [kind + 'At']: null });
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
      for (const k of ['found', 'solved', 'gifts', 'giftsAt', 'lastAt', 'clueAt', 'finishedAt']) upd['players/' + id + '/' + k] = null;
    }
    return write('update', '', upd);
  }
  // MC: delete leftover records (see ghostIds). clearProgress and newGame do this too.
  function removeGhosts() {
    const upd = {};
    for (const id of ghostIds(tree)) upd['players/' + id] = null;
    return Object.keys(upd).length ? write('update', '', upd) : Promise.resolve();
  }
  // MC: remove every player and all progress.
  const newGame = () => write('update', '', { players: null, meta: null });

  window.StarStore = {
    mode: firebaseUrl ? 'online' : 'demo',
    gameId,
    SERVER_TIME,
    get tree() { return tree; },
    get loaded() { return loaded; },
    get connected() { return connected; },
    subscribe(fn) { listeners.push(fn); if (tree) fn(tree, connected); },
    // low-level writes (prefer the helpers below)
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

  if (firebaseUrl) connect();
  else {
    connected = true; loaded = true;
    tree = localRead();
    window.addEventListener('storage', e => { if (e.key === LOCAL_KEY) localRefresh(); });
    if (channel) channel.onmessage = localRefresh;
  }
})();
