import { $, api, copy, h, toast } from './common.js';

const KEY = 'csm.hosted';
const hosted = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
};

function showRecent() {
  const list = hosted();
  if (!list.length) return;
  $('#recent').classList.remove('hidden');
  $('#recentList').replaceChildren(
    ...list.map((e) => h('a', { class: 'item', href: e.hostUrl, style: 'text-decoration:none;color:inherit' }, h('div', { class: 'grow' }, h('div', { class: 't', text: e.name }), h('div', { class: 'small muted', text: new Date(e.at).toLocaleDateString() })), h('span', { class: 'pill', text: 'Open →' }))),
  );
}

$('#createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const name = $('#evName').value.trim();
    const out = await api('/api/events', { method: 'POST', body: { name, password: $('#evPassword').value } });
    try {
      localStorage.setItem(KEY, JSON.stringify([{ name: name || 'Our Christmas Eve', hostUrl: out.hostUrl, at: Date.now() }, ...hosted()].slice(0, 10)));
    } catch {}
    $('#create').classList.add('hidden');
    $('#created').classList.remove('hidden');
    $('#hostLink').value = out.hostUrl;
    $('#goHost').href = out.hostUrl;
    $('#copyHost').onclick = () => copy(out.hostUrl);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});
showRecent();
