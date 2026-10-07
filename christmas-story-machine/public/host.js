import { $, api, copy, h, toast, eventIdFromPath, STATUS, TYPE, fmtTime, fmtDur } from './common.js';

const EID = eventIdFromPath();
let state = null;
let editing = null;

async function login() {
  const m = location.hash.match(/key=([\w-]+)/);
  if (m) {
    try {
      await api(`/api/e/${EID}/host-login`, { method: 'POST', body: { key: m[1] } });
    } catch (err) {
      toast(err.message);
    }
    history.replaceState(null, '', location.pathname); // keep the key out of the address bar
  }
}

async function refresh() {
  try {
    state = await api(`/api/e/${EID}/state`);
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      $('#noAccess').classList.remove('hidden');
      $('#app').classList.add('hidden');
      return false;
    }
    return true;
  }
  $('#noAccess').classList.add('hidden');
  $('#app').classList.remove('hidden');
  render();
  return true;
}

// ------------------------------------------------------------------ render
let settingsFilled = false;
function render() {
  const s = state;
  document.title = `Host · ${s.name}`;
  $('#evName').textContent = s.name;
  $('#addMine').href = `/e/${EID}`;
  if ($('#invite').value !== s.inviteUrl) {
    $('#invite').value = s.inviteUrl;
    const src = `/api/e/${EID}/qr.svg?u=${encodeURIComponent(s.inviteUrl)}`;
    $('#qr').src = src;
    $('#qrBig').src = src;
  }
  if (!settingsFilled) {
    settingsFilled = true;
    $('#setName').value = s.name;
    $('#dedication').value = s.settings.dedication || '';
    $('#order').value = s.settings.order;
    $('#music').value = s.settings.music;
    $('#volume').value = s.settings.musicVolume ?? 0.35;
    $('#review').checked = Boolean(s.settings.requireReview);
    $('#narrator').value = s.settings.narrator || 'santa';
  }
  $('#customMusicRow').classList.toggle('hidden', $('#music').value !== 'custom');
  $('#narratorNote').textContent = s.ai.voice
    ? 'The narrator is recorded into the video. Changing it re-records the stories when you compile.'
    : 'The reveal screen reads the stories aloud in this voice. For a truly Santa-sounding narrator recorded into the video, add a voice key (see the README).';
  $('#musicName').textContent = s.settings.customMusicName ? `Using: ${s.settings.customMusicName}` : '';

  $('#aiCard').replaceChildren(
    h('strong', {}, 'Helpers'),
    h('div', {}, s.ai.claude ? '✅ Claude writes captions, plans stories and double-checks everything is family-friendly.' : '⚪ Claude is off — warm template captions are used. Set ANTHROPIC_API_KEY to turn it on.'),
    h('div', {}, s.ai.voice ? '✅ A narrator voice is recorded into the video.' : '⚪ Narration is read aloud by the reveal screen’s own voice (set ELEVENLABS_API_KEY or OPENAI_API_KEY to record a narrator into the video).'),
    h('div', {}, s.ai.stock ? '✅ Stock photos may illustrate long stories.' : '⚪ Stories are illustrated with built-in Christmas artwork.'),
  );

  // stats
  const by = (f) => s.contributions.filter(f).length;
  const ready = by((c) => c.status === 'ready' && !c.host.hidden && !c.host.review?.held);
  const busy = by((c) => ['queued', 'writing', 'rendering'].includes(c.status));
  const held = by((c) => c.host.review?.held);
  const failed = by((c) => c.status === 'failed');
  $('#stats').replaceChildren(
    ...[h('span', { class: 'pill ok' }, `${ready} ready`),
    busy ? h('span', { class: 'pill busy' }, `${busy} being prepared`) : null,
    held ? h('span', { class: 'pill warn' }, `${held} waiting for you`) : null,
    failed ? h('span', { class: 'pill bad' }, `${failed} failed`) : null,
    h('span', { class: 'pill', style: 'background:#0b16341a;color:#1d2340' }, `${s.contributions.length} total`)].filter(Boolean),
  );

  // compile
  const comp = s.compile || {};
  const running = comp.status === 'running';
  $('#compile').disabled = running || !ready;
  $('#compile').textContent = running ? 'Compiling…' : comp.output ? '🎬 Re-compile with latest' : '🎬 Compile the keepsake';
  $('#compileStatus').classList.toggle('hidden', !running && comp.status !== 'failed');
  $('#bar').style.width = `${Math.round((comp.progress || 0) * 100)}%`;
  $('#compileMsg').textContent = comp.status === 'failed' ? `${comp.message} ${comp.error || ''}` : busy && running ? `${comp.message || ''} (pieces still being prepared will be in the next compile)` : comp.message || '';
  if (comp.output) {
    $('#doneBox').classList.remove('hidden');
    const v = comp.output.version;
    if ($('#finalVideo').dataset.v !== String(v)) {
      $('#finalVideo').dataset.v = v;
      $('#finalVideo').src = `/api/e/${EID}/keepsake.mp4?v=${v}`;
      $('#finalVideo').poster = `/api/e/${EID}/keepsake.jpg?v=${v}`;
    }
    $('#finalMeta').textContent = `${comp.output.pieces} pieces · ${fmtDur(comp.output.duration)} · made ${fmtTime(comp.output.builtAt)}`;
    $('#download').href = `/api/e/${EID}/keepsake.mp4?download=1&v=${v}`;
    $('#reveal').href = `/reveal/${EID}`;
    $('#share').value = s.shareUrl || '';
  }

  // pieces in running order
  const byId = new Map(s.contributions.map((c) => [c.id, c]));
  const inOrder = new Set();
  const nodes = [];
  for (const g of s.order) {
    if (g.family && s.order.length > 1) nodes.push(h('h3', { class: 'familyhead' }, g.family));
    for (const id of g.ids) {
      inOrder.add(id);
      nodes.push(piece(byId.get(id)));
    }
  }
  const rest = s.contributions.filter((c) => !inOrder.has(c.id)).sort((a, b) => a.seq - b.seq);
  if (rest.length) {
    nodes.push(h('h3', { class: 'familyhead' }, 'Not in the keepsake yet'));
    rest.forEach((c) => nodes.push(piece(c)));
  }
  $('#pieces').replaceChildren(...nodes);
  $('#empty').classList.toggle('hidden', s.contributions.length > 0);
}

function piece(c) {
  const [icon, label] = TYPE[c.type];
  const [st, cls] = STATUS[c.status] || [c.status, ''];
  const held = c.host.review?.held;
  const poster = c.hasPoster
    ? h('img', { class: 'poster', src: `/api/e/${EID}/media/${c.id}/poster?d=${c.host.duration}`, alt: `Preview of ${c.title || label}`, onclick: () => preview(c) })
    : h('div', { class: 'poster', style: 'display:grid;place-items:center;font-size:2.4rem' }, icon);
  const actions = [];
  if (held) actions.push(h('button', { class: 'btn small gold', onclick: () => patch(c.id, { approved: true }, 'Approved') }, '✓ Approve'));
  if (c.hasPoster) actions.push(h('button', { class: 'btn small', onclick: () => preview(c) }, '▶ Preview'));
  actions.push(h('button', { class: 'btn small', onclick: () => openEdit(c) }, '✎ Edit words'));
  actions.push(h('button', { class: 'btn small', onclick: () => patch(c.id, { hidden: !c.host.hidden }, c.host.hidden ? 'Back in the keepsake' : 'Left out of the keepsake') }, c.host.hidden ? '👁 Include' : '🙈 Leave out'));
  actions.push(h('button', { class: 'btn small', title: 'Move earlier', onclick: () => move(c.id, 'up') }, '↑'));
  actions.push(h('button', { class: 'btn small', title: 'Move later', onclick: () => move(c.id, 'down') }, '↓'));
  if (c.type !== 'story') actions.push(h('a', { class: 'btn small', href: `/api/e/${EID}/media/${c.id}/original?download=1` }, '⬇ Original'));
  if (c.status === 'failed') actions.push(h('button', { class: 'btn small gold', onclick: () => retry(c.id) }, '↻ Retry'));
  actions.push(h('button', { class: 'btn small', onclick: () => remove(c) }, '🗑'));
  return h('article', { class: `piece${held ? ' held' : ''}${c.host.hidden ? ' hiddenpiece' : ''}` },
    poster,
    h('div', {},
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
        h('strong', {}, `${icon} ${c.title || label}`),
        h('span', { class: `pill ${cls}`, style: cls ? '' : 'background:#0b16341a;color:#1d2340' }, st),
        c.host.style ? h('span', { class: 'pill', style: 'background:#0b16341a;color:#1d2340', title: c.host.styleReason }, c.host.style === 'animated' ? 'Animated scene' : 'Narrated slideshow') : null,
      ),
      h('div', { class: 'meta' }, `${c.name}${c.age != null ? `, ${c.age}` : ''}${c.family ? ` · ${c.family}` : ''} · ${fmtTime(c.createdAt)}${c.host.duration ? ` · ${fmtDur(c.host.duration)}` : ''}`),
      c.caption ? h('p', { class: 'cap' }, c.caption) : null,
      c.type === 'story' && c.host.text ? h('p', { class: 'small', style: 'margin:0;color:#5d6385;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden' }, `“${c.host.text}”`) : null,
      held ? h('div', { class: 'held-note' }, `⏸ Held for you: ${c.host.review.reason}`) : null,
      c.host.error ? h('div', { class: 'held-note' }, `⚠️ ${c.host.error}`) : null,
      h('div', { class: 'actions' }, actions),
    ),
  );
}

// ------------------------------------------------------------------ actions
async function patch(cid, body, msg) {
  try {
    await api(`/api/e/${EID}/contributions/${cid}`, { method: 'PATCH', body });
    if (msg) toast(msg);
    refresh();
  } catch (err) {
    toast(err.message);
  }
}
async function move(cid, direction) {
  await api(`/api/e/${EID}/contributions/${cid}/move`, { method: 'POST', body: { direction } }).catch((e) => toast(e.message));
  refresh();
}
async function retry(cid) {
  await api(`/api/e/${EID}/contributions/${cid}/retry`, { method: 'POST' }).catch((e) => toast(e.message));
  refresh();
}
async function remove(c) {
  if (!confirm(`Delete “${c.title || TYPE[c.type][1]}” by ${c.name}? This can't be undone.`)) return;
  await api(`/api/e/${EID}/contributions/${c.id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
  refresh();
}
function preview(c) {
  const v = $('#previewVideo');
  v.src = `/api/e/${EID}/media/${c.id}/segment?d=${c.host.duration}`;
  $('#previewDlg').showModal();
  v.play().catch(() => {});
}
$('#closePreview').onclick = () => $('#previewDlg').close();
$('#previewDlg').addEventListener('close', () => $('#previewVideo').pause());

function openEdit(c) {
  editing = c;
  $('#editTitle').textContent = `Edit words · ${TYPE[c.type][1]} by ${c.name}`;
  $('#eName').value = c.name || '';
  $('#eAge').value = c.age ?? '';
  $('#eFamily').value = c.family || '';
  $('#eTitleIn').value = c.title || '';
  $('#eCaption').value = c.host.userCaption || c.caption || '';
  $('#eNarrationWrap').classList.toggle('hidden', c.type === 'story');
  $('#eNarration').value = c.host.narration || '';
  $('#eScenes').replaceChildren(
    ...(c.host.scenes || []).map((s, i) =>
      h('div', {}, h('label', { for: `scene${i}` }, `Scene ${i + 1} narration `, h('span', { class: 'opt' }, `(${s.setting.replace(/-/g, ' ')})`)), h('textarea', { id: `scene${i}`, maxlength: '420', style: 'min-height:70px' }, s.narration)),
    ),
  );
  $('#eOriginal').classList.toggle('hidden', !c.host.text);
  $('#eText').textContent = c.host.text || '';
  $('#editDlg').showModal();
}
$('#editForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save' || !editing) return;
  const c = editing;
  const body = { name: $('#eName').value, age: $('#eAge').value, family: $('#eFamily').value, title: $('#eTitleIn').value, caption: $('#eCaption').value };
  if (c.type === 'story') body.sceneNarrations = (c.host.scenes || []).map((_, i) => $(`#scene${i}`).value);
  else body.narration = $('#eNarration').value;
  patch(c.id, body, 'Saved — re-making that piece');
});

let settingsTimer;
function saveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    await api(`/api/e/${EID}/settings`, {
      method: 'PATCH',
      body: { name: $('#setName').value, dedication: $('#dedication').value, order: $('#order').value, music: $('#music').value, musicVolume: Number($('#volume').value), requireReview: $('#review').checked, narrator: $('#narrator').value },
    }).catch((e) => toast(e.message));
    toast('Saved');
    refresh();
  }, 500);
}
for (const id of ['setName', 'dedication']) $(`#${id}`).addEventListener('input', saveSettings);
for (const id of ['order', 'music', 'volume', 'review', 'narrator']) $(`#${id}`).addEventListener('change', saveSettings);
$('#musicFile').addEventListener('change', async () => {
  const f = $('#musicFile').files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('file', f);
  try {
    await api(`/api/e/${EID}/music`, { method: 'POST', body: fd });
    toast('Music uploaded');
    refresh();
  } catch (e) {
    toast(e.message);
  }
});

$('#compile').onclick = async () => {
  const busy = state.contributions.filter((c) => ['queued', 'writing', 'rendering'].includes(c.status)).length;
  const held = state.contributions.filter((c) => c.host.review?.held).length;
  const notes = [busy ? `${busy} piece(s) are still being prepared and will be left out` : '', held ? `${held} piece(s) are waiting for your approval and will be left out` : ''].filter(Boolean);
  if (notes.length && !confirm(`${notes.join('; ')}. Compile now anyway?`)) return;
  await api(`/api/e/${EID}/compile`, { method: 'POST' }).catch((e) => toast(e.message));
  refresh();
};
$('#copyInvite').onclick = () => copy($('#invite').value);
$('#copyShare').onclick = () => copy($('#share').value);
$('#rotateShare').onclick = async () => {
  if (!confirm('Make a new share link? The old one will stop working.')) return;
  const out = await api(`/api/e/${EID}/share/rotate`, { method: 'POST' });
  $('#share').value = out.shareUrl;
  toast('New share link made');
};
$('#rotateInvite').onclick = async () => {
  if (!confirm('Make a new invite link? Phones that already joined keep working; the old link and QR stop working for new guests.')) return;
  await api(`/api/e/${EID}/invite/rotate`, { method: 'POST' });
  refresh();
};
$('#bigQr').onclick = () => {
  $('#qrTitle').textContent = state.name;
  $('#qrDlg').showModal();
};
$('#closeQr').onclick = () => $('#qrDlg').close();

// ------------------------------------------------------------------ boot
(async () => {
  await login();
  if (await refresh()) {
    setInterval(() => {
      if (!document.querySelector('dialog[open]')) refresh();
    }, 2500);
  }
})();
