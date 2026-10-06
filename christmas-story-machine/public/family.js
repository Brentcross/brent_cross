import { $, $$, api, h, snowBurst, toast, eventIdFromPath, STATUS, TYPE } from './common.js';

const EID = eventIdFromPath();
const WHO_KEY = `csm.who.${EID}`;
let current = null; // 'story' | 'drawing' | 'photo'
let who = load(WHO_KEY) || null;

function load(k) {
  try {
    return JSON.parse(localStorage.getItem(k));
  } catch {
    return null;
  }
}
function save(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

// ------------------------------------------------------------------ outbox
// Submissions are written to IndexedDB first and sent from there, so a flaky
// connection or a busy server never loses a child's story. Retries back off
// and resume when the page is reopened.
const outbox = (() => {
  let db = null;
  const memory = new Map();
  const open = () =>
    new Promise((resolve) => {
      try {
        const req = indexedDB.open('csm-outbox', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('items', { keyPath: 'clientId' });
        req.onsuccess = () => resolve((db = req.result));
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  const tx = (mode, fn) =>
    new Promise((resolve) => {
      if (!db) return resolve(fn(null));
      const t = db.transaction('items', mode);
      const r = fn(t.objectStore('items'));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => resolve(null);
    });
  return {
    ready: open(),
    async put(item) {
      memory.set(item.clientId, item);
      await tx('readwrite', (s) => s && s.put(item));
    },
    async del(id) {
      memory.delete(id);
      await tx('readwrite', (s) => s && s.delete(id));
    },
    async all() {
      const fromDb = (await tx('readonly', (s) => s && s.getAll())) || [];
      for (const i of fromDb) if (!memory.has(i.clientId)) memory.set(i.clientId, i);
      return [...memory.values()].filter((i) => i.eventId === EID);
    },
  };
})();

let sending = false;
async function flush() {
  if (sending) return;
  sending = true;
  try {
    for (const item of await outbox.all()) {
      if (item.failed) continue;
      let delay = 2000;
      for (;;) {
        try {
          await send(item);
          await outbox.del(item.clientId);
          break;
        } catch (err) {
          if (err.permanent) {
            item.failed = err.message;
            await outbox.put(item);
            toast(err.message, 5000);
            break;
          }
          item.note = navigator.onLine ? 'Busy — trying again…' : 'Offline — will send when connected';
          renderMine();
          await new Promise((r) => setTimeout(r, delay + Math.random() * 1000));
          delay = Math.min(delay * 2, 30000);
        }
      }
    }
  } finally {
    sending = false;
    refreshMine();
  }
}

function send(item) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(item.fields)) fd.append(k, v ?? '');
    fd.append('clientId', item.clientId);
    if (item.file) fd.append('file', item.file, item.fileName || 'picture.jpg');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/e/${EID}/contributions`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        item.progress = e.loaded / e.total;
        renderMine();
      }
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const err = new Error(data.error || 'Could not send');
      err.permanent = xhr.status >= 400 && xhr.status < 500 && xhr.status !== 408 && xhr.status !== 429;
      reject(err);
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.timeout = 10 * 60 * 1000;
    xhr.ontimeout = () => reject(new Error('Timed out'));
    xhr.send(fd);
  });
}
addEventListener('online', flush);

// ------------------------------------------------------------------ who
function showWho() {
  if (who?.name) {
    $('#whoForm').classList.add('hidden');
    $('#whoShow').classList.remove('hidden');
    $('#whoTitle').textContent = `Merry Christmas, ${who.name}!`;
    $('#whoName').textContent = who.name;
    $('#avatar').textContent = who.name.trim()[0]?.toUpperCase() || '★';
    $('#whoMeta').textContent = [who.age ? `Age ${who.age}` : '', who.family].filter(Boolean).join(' · ') || 'Sharing from this device';
    $('#pick').classList.remove('hidden');
  } else {
    $('#whoForm').classList.remove('hidden');
    $('#whoShow').classList.add('hidden');
    $('#whoTitle').textContent = "First, who's sharing?";
    $('#pick').classList.add('hidden');
    $('#form').classList.add('hidden');
  }
}
$('#whoForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#name').value.trim();
  if (!name) return $('#name').focus();
  who = { name, age: $('#age').value.trim(), family: $('#family').value.trim() };
  save(WHO_KEY, who);
  showWho();
});
$('#changeWho').addEventListener('click', () => {
  // Several people often share one tablet; make switching easy.
  $('#name').value = '';
  $('#age').value = '';
  $('#family').value = who?.family || '';
  who = null;
  showWho();
  $('#name').focus();
});

// ------------------------------------------------------------------ the three entry points
const COPY = {
  story: { title: '✍️ Tell a story', hint: 'A memory, a Christmas wish, something funny that happened today — anything! Little ones can tell it to a grown-up who types.', send: 'Add my story ✨' },
  drawing: { title: '🖍️ Share a drawing', hint: 'Lay your drawing flat in good light and take a photo from straight above.', send: 'Add my drawing ✨', keep: 'Your drawing will appear exactly as you made it — we never change the artwork.' },
  photo: { title: '📷 Share a photo', hint: 'Choose a favorite photo from tonight (or any Christmas memory).', send: 'Add my photo ✨', keep: 'Your photo is kept in its original form.' },
};

function choose(type) {
  current = type;
  $$('.choice').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === type)));
  const f = $('#form');
  f.reset();
  $('#preview').classList.add('hidden');
  $('#dropText').classList.remove('hidden');
  f.classList.remove('hidden');
  $('#formTitle').textContent = COPY[type].title;
  $('#formHint').textContent = COPY[type].hint;
  $('#send').textContent = COPY[type].send;
  $('#storyFields').classList.toggle('hidden', type !== 'story');
  $('#fileFields').classList.toggle('hidden', type === 'story');
  $('#keepNote').textContent = COPY[type].keep || '';
  const file = $('#file');
  // Drawings: open the camera straight away on phones. Photos: open the library.
  if (type === 'drawing') file.setAttribute('capture', 'environment');
  else file.removeAttribute('capture');
  updateCount();
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (type === 'story') setTimeout(() => $('#text').focus({ preventScroll: true }), 350);
}
$$('.choice').forEach((b) => b.addEventListener('click', () => choose(b.dataset.type)));
$('#cancel').addEventListener('click', () => {
  $('#form').classList.add('hidden');
  $$('.choice').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  current = null;
});

function updateCount() {
  const n = ($('#text').value.match(/\S+/g) || []).length;
  $('#count').textContent = `${n} word${n === 1 ? '' : 's'}${n > 70 ? ' · this will become a narrated slideshow' : n > 0 ? ' · short and sweet: this will become an animated scene' : ''}`;
}
$('#text').addEventListener('input', updateCount);

let previewUrl;
$('#file').addEventListener('change', () => {
  const f = $('#file').files[0];
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (!f) return;
  previewUrl = URL.createObjectURL(f);
  const img = $('#preview');
  img.src = previewUrl;
  img.classList.remove('hidden');
  $('#dropText').innerHTML = '<span class="small">Tap to choose a different picture</span>';
  img.onerror = () => {
    // Some formats (e.g. HEIC on desktop) can't be previewed but upload fine.
    img.classList.add('hidden');
    $('#dropText').textContent = `📎 ${f.name}`;
  };
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!who?.name) return showWho();
  const fields = {
    type: current,
    name: who.name,
    age: who.age || '',
    family: who.family || '',
    title: $('#title').value.trim(),
    caption: $('#caption').value.trim(),
    text: current === 'story' ? $('#text').value.trim() : '',
  };
  const file = current === 'story' ? null : $('#file').files[0];
  if (current === 'story' && fields.text.length < 3) return toast('Write a little story first!'), $('#text').focus();
  if (current !== 'story' && !file) return toast('Choose a picture first!');
  const item = {
    clientId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    eventId: EID,
    fields,
    file, // stored as an untouched Blob — never resized or recompressed
    fileName: file?.name,
    at: Date.now(),
  };
  await outbox.put(item);
  snowBurst();
  toast(current === 'story' ? 'Thank you! Your story is on its way 🎄' : 'Thank you! It’s on its way 🎄');
  $('#form').classList.add('hidden');
  $$('.choice').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  current = null;
  renderMine();
  scrollTo({ top: 0, behavior: 'smooth' });
  flush();
});

// ------------------------------------------------------------------ my contributions
let serverItems = [];
let total = 0;
async function refreshMine() {
  try {
    const data = await api(`/api/e/${EID}/mine`);
    serverItems = data.items;
    total = data.total;
  } catch {}
  renderMine();
}

async function renderMine() {
  const pending = await outbox.all();
  const rows = [];
  for (const p of pending) {
    const [icon, label] = TYPE[p.fields.type];
    rows.push(
      h('div', { class: 'item' },
        h('div', { style: 'font-size:1.6rem' }, icon),
        h('div', { class: 'grow' }, h('div', { class: 't', text: p.fields.title || `${label} by ${p.fields.name}` }), h('div', { class: 'small muted', text: p.failed ? p.failed : p.note || (p.progress ? `Sending… ${Math.round(p.progress * 100)}%` : 'Sending…') })),
        p.failed ? h('button', { class: 'btn small ghost', onclick: async () => { await outbox.del(p.clientId); renderMine(); } }, 'Remove') : h('span', { class: 'pill busy' }, 'Sending'),
      ),
    );
  }
  for (const c of [...serverItems].reverse()) {
    const [icon, label] = TYPE[c.type];
    const [st, cls] = STATUS[c.status] || [c.status, ''];
    const thumb = c.hasPoster ? h('img', { class: 'thumb', src: `/api/e/${EID}/media/${c.id}/poster?v=${encodeURIComponent(c.statusDetail + c.status)}`, alt: '' }) : h('div', { style: 'font-size:1.6rem;width:64px;text-align:center' }, icon);
    rows.push(
      h('div', { class: 'item' }, thumb,
        h('div', { class: 'grow' }, h('div', { class: 't', text: c.title || `${label} by ${c.name}` }), h('div', { class: 'small muted', text: c.caption || `${label} by ${c.name}` })),
        h('span', { class: `pill ${cls}` }, st),
      ),
    );
  }
  $('#mine').replaceChildren(...(rows.length ? rows : [h('p', { class: 'muted small', style: 'margin:0' }, 'Nothing yet — your pieces will show up here.')]));
  $('#total').textContent = total ? `${total} piece${total === 1 ? '' : 's'} shared by the whole family so far. The big reveal is at the end of the night!` : '';
}

// ------------------------------------------------------------------ boot
async function boot() {
  let me;
  try {
    me = await api(`/api/e/${EID}/me`);
  } catch {
    me = { role: null };
  }
  if (!me.role) {
    $('#noAccess').classList.remove('hidden');
    return;
  }
  $('#app').classList.remove('hidden');
  $('#evName').textContent = me.name;
  document.title = `Add to ${me.name}`;
  if (me.role === 'host') {
    $('#hostLink').classList.remove('hidden');
    $('#hostLink').href = `/host/${EID}`;
  }
  if (who) {
    $('#name').value = who.name || '';
    $('#age').value = who.age || '';
    $('#family').value = who.family || '';
  }
  showWho();
  let shownVersion = 0;
  const checkReveal = (m) => {
    if (m.revealed && m.keepsakeVersion !== shownVersion) {
      shownVersion = m.keepsakeVersion;
      $('#revealBanner').classList.remove('hidden');
      $('#keepsake').src = `/api/e/${EID}/keepsake.mp4?v=${m.keepsakeVersion}`;
      $('#keepsake').poster = `/api/e/${EID}/keepsake.jpg?v=${m.keepsakeVersion}`;
      $('#downloadKeepsake').href = `/api/e/${EID}/keepsake.mp4?download=1&v=${m.keepsakeVersion}`;
    }
  };
  checkReveal(me);
  await outbox.ready;
  refreshMine();
  flush();
  setInterval(refreshMine, 5000);
  setInterval(async () => {
    try {
      checkReveal(await api(`/api/e/${EID}/me`));
    } catch {}
    flush();
  }, 15000);
}
boot();
