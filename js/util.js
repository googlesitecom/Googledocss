/* util.js — helpers de DOM, formato y UI (toasts, modales, avatares) */
'use strict';

const $ = (s, c) => (c || document).querySelector(s);
const $$ = (s, c) => [...(c || document).querySelectorAll(s)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const rid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const truncate = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/* ---- fechas ---- */
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}
function sameDay(a, b) {
  const d1 = new Date(a), d2 = new Date(b);
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}
function fmtDay(ts) {
  const now = Date.now();
  if (sameDay(ts, now)) return fmtTime(ts);
  if (sameDay(ts, now - 864e5)) return 'Ayer';
  return new Date(ts).toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function fmtDayLong(ts) {
  const now = Date.now();
  if (sameDay(ts, now)) return 'Hoy';
  if (sameDay(ts, now - 864e5)) return 'Ayer';
  return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'long' });
}

/* ---- avatares ---- */
function hueOf(s) {
  let h = 7;
  for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function initials(name) {
  const n = String(name || '?').trim();
  if (!n) return '?';
  const parts = n.split(/\s+/);
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] || ''))).toUpperCase();
}
function avatarStyle(el, uid) {
  el.style.setProperty('--h', hueOf(uid));
}
function avatarDataURL(name, size = 96) {
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const h = hueOf(name);
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, `hsl(${h} 62% 52%)`);
    g.addColorStop(1, `hsl(${(h + 38) % 360} 58% 40%)`);
    ctx.fillStyle = g;
    const r = size * 0.28;
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, r);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${size * 0.34}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(name), size / 2, size / 2 + size * 0.02);
    return cv.toDataURL('image/png');
  } catch (e) { return undefined; }
}

/* ---- enlaces en mensajes ---- */
function linkify(escaped) {
  return escaped.replace(/((?:https?:\/\/|www\.)[^\s<]+)/gi, (m) => {
    const href = m.startsWith('http') ? m : 'https://' + m;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${m}</a>`;
  });
}

/* ---- toasts ---- */
const UI = {
  toast(text, opts = {}) {
    const box = $('#toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<svg class="icon"><use href="#i-${opts.icon || 'chat'}"/></svg><span>${esc(text)}</span>`;
    const kill = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 240);
    };
    if (opts.onClick) el.addEventListener('click', () => { opts.onClick(); kill(); });
    else el.addEventListener('click', kill);
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(kill, opts.ms || 4200);
  },
  confirm(title, body, okText = 'Eliminar', danger = true) {
    return new Promise((resolve) => {
      const root = $('#modalRoot');
      root.innerHTML = `
        <div class="modal">
          <h3>${esc(title)}</h3>
          <p>${esc(body)}</p>
          <div class="m-acts">
            <button class="btn-ghost" data-r="0">Cancelar</button>
            <button class="${danger ? 'btn-danger' : 'btn-primary'}" data-r="1">${esc(okText)}</button>
          </div>
        </div>`;
      root.hidden = false;
      root.onclick = (e) => {
        const b = e.target.closest('[data-r]');
        if (!b) return;
        root.hidden = true;
        root.innerHTML = '';
        root.onclick = null;
        resolve(b.dataset.r === '1');
      };
    });
  }
};
