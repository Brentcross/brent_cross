// Shared helpers for all pages.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
    body: opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
export function toast(msg, ms = 2800) {
  let el = $('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function snowBurst(n = 40) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = h('div', { class: 'snow', 'aria-hidden': 'true' });
  const glyphs = ['❄', '✦', '❅', '★', '❆'];
  for (let i = 0; i < n; i++) {
    const s = h('i', { text: glyphs[i % glyphs.length] });
    s.style.left = `${Math.random() * 100}%`;
    s.style.fontSize = `${10 + Math.random() * 18}px`;
    s.style.animationDuration = `${2.5 + Math.random() * 2.5}s`;
    s.style.animationDelay = `${Math.random() * 0.8}s`;
    s.style.color = Math.random() < 0.3 ? '#f4d58d' : '#fff';
    box.append(s);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 6000);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied!');
  } catch {
    prompt('Copy this link:', text);
  }
}

export const eventIdFromPath = () => location.pathname.split('/').filter(Boolean)[1];

export const STATUS = {
  queued: ['Waiting in line', 'busy'],
  received: ['Received', 'busy'],
  writing: ['Writing words', 'busy'],
  rendering: ['Making the video', 'busy'],
  ready: ['Ready ✨', 'ok'],
  failed: ['Needs a retry', 'bad'],
};
export const TYPE = { story: ['✍️', 'Story'], drawing: ['🖍️', 'Drawing'], photo: ['📷', 'Photo'] };

export function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function fmtDur(s) {
  s = Math.round(s || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
