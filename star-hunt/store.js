// Shared game state for the player, TV and MC screens.
//
// The whole game is one small JSON tree:
//   meta:    { mcPinHash, startedAt, released }   released = how many clues the MC has opened
//   players: { id: { name, team, members, pinHash, found, solved, gifts, lastAt, finishedAt } }
//
// Online mode talks to the Firebase Realtime Database REST API (live updates over
// EventSource), so no SDK is needed. Demo mode keeps the tree in localStorage and
// syncs between tabs of the same browser.
(function () {
  'use strict';
  const cfg = window.STAR_HUNT_CONFIG || {};
  const gameId = cfg.gameId || 'christmas';
  const firebaseUrl = (cfg.firebaseUrl || '').trim().replace(/\/+$/, '');
  const SERVER_TIME = { '.sv': 'timestamp' };

  let tree = null;           // latest known game tree (null until loaded)
  let connected = false;
  const listeners = [];

  // ---------- tree helpers ----------
  const split = path => String(path || '').split('/').filter(Boolean);
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

  // Mirror the database: server timestamps become numbers, empty objects and nulls vanish.
  function clean(v) {
    if (v && typeof v === 'object') {
      if (v['.sv'] === 'timestamp') return Date.now();
      const out = Array.isArray(v) ? [] : {};
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
  function remote(method, path, body) {
    const url = base + (split(path).length ? '/' + split(path).map(encodeURIComponent).join('/') : '') + '.json';
    return fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(r => { if (!r.ok) throw new Error('Save failed (' + r.status + ')'); })
      .catch(err => { console.error(err); window.dispatchEvent(new CustomEvent('star-store-error', { detail: err })); });
  }
  function connect() {
    const es = new EventSource(base + '.json');
    es.addEventListener('put', e => {
      const msg = JSON.parse(e.data);
      tree = msg.path === '/' ? clean(msg.data) || {} : setAt(tree || {}, msg.path, msg.data) || {};
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
  function write(kind, path, value) {
    if (kind === 'set') tree = setAt(clone(tree) || {}, path, value) || {};
    else tree = applyUpdate(clone(tree) || {}, path, value) || {};
    notify();
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

  // ---------- helpers shared by the screens ----------
  const arr = v => (Array.isArray(v) ? v.filter(x => x != null) : v && typeof v === 'object' ? Object.values(v) : []);

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

  const players = t => {
    const p = (t && t.players) || {};
    return Object.keys(p).map(id => Object.assign({ id }, p[id], {
      found: arr(p[id].found), solved: arr(p[id].solved), gifts: arr(p[id].gifts), members: arr(p[id].members),
    }));
  };

  // Race order: finishers by finish time, then everyone else by stars solved and who got there first.
  function standings(t) {
    return players(t).sort((a, b) => {
      if (a.finishedAt && b.finishedAt) return a.finishedAt - b.finishedAt;
      if (a.finishedAt || b.finishedAt) return a.finishedAt ? -1 : 1;
      if (b.solved.length !== a.solved.length) return b.solved.length - a.solved.length;
      return (a.lastAt || a.createdAt || 0) - (b.lastAt || b.createdAt || 0);
    });
  }

  const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

  window.StarStore = {
    mode: firebaseUrl ? 'online' : 'demo',
    gameId,
    SERVER_TIME,
    get tree() { return tree; },
    subscribe(fn) { listeners.push(fn); if (tree) fn(tree, connected); },
    set: (path, value) => write('set', path, value),
    update: (path, obj) => write('update', path, obj),
    remove: path => write('set', path, null),
    arr, uid, hashPin, players, standings, ordinal,
  };

  if (firebaseUrl) connect();
  else {
    connected = true;
    tree = localRead();
    window.addEventListener('storage', e => { if (e.key === LOCAL_KEY) localRefresh(); });
    if (channel) channel.onmessage = localRefresh;
  }
})();
