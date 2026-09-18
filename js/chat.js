/* chat.js — mensajería real
   - Texto: tema único por mensaje, retenido + expiración 7 días (bandeja offline)
   - Imágenes: compresión en canvas + transferencia por chunks + IndexedDB
   - Acuses de recibo (✓✓), indicador de escritura, historial local (400/conversación)
   - Entrega == suscripción dm/<yo>/# : en vivo o retenida al reconectar          */
'use strict';

const CHUNK = 48000; /* caracteres base64 por publicacion */

function b64ToBlob(b64, type = 'image/jpeg') {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

async function compressImage(file, maxDim = 1280, q = 0.78) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  const dataURL = cv.toDataURL('image/jpeg', q);
  return { b64: dataURL.split(',')[1], w, h };
}

const Chat = {
  active: null,
  _cache: {},        /* friendUid -> [mensajes] */
  _chunkBuf: {},     /* msgId -> {from, n, meta, chunks} */
  _typingTimers: {},
  _lastTypingSent: 0,
  _objUrls: {},

  /* ================= historial ================= */
  hist(f) {
    if (!this._cache[f]) this._cache[f] = LS.get(K.hist(Auth.me.uid, f), []);
    return this._cache[f];
  },
  addHist(f, m) {
    const h = this.hist(f);
    h.push(m);
    if (h.length > 400) h.splice(0, h.length - 400);
    LS.set(K.hist(Auth.me.uid, f), h);
  },
  hasMsg(f, id) { return this.hist(f).some((m) => m.id === id); },
  lastMsg(f) { const h = this.hist(f); return h.length ? h[h.length - 1] : null; },
  lastActivity(f) {
    const m = this.lastMsg(f);
    const fr = Friends.friend(f);
    return (m && m.ts) || (fr && fr.since) || 0;
  },

  /* ================= no leídos ================= */
  unread(f) { return (LS.get(K.unread(Auth.me.uid), {}))[f] || 0; },
  bumpUnread(f) {
    const u = LS.get(K.unread(Auth.me.uid), {});
    u[f] = (u[f] || 0) + 1;
    LS.set(K.unread(Auth.me.uid), u);
  },
  clearUnread(f) {
    const u = LS.get(K.unread(Auth.me.uid), {});
    if (u[f]) {
      delete u[f];
      LS.set(K.unread(Auth.me.uid), u);
    }
    App.renderConvoList();
    App.updateTitle();
  },

  /* ================= abrir / cerrar ================= */
  open(uid) {
    this.active = uid;
    App.setChatOpen(true);
    $('#chatView').hidden = false;
    $('#emptyState').hidden = true;
    const fr = Friends.friend(uid);
    const name = fr ? fr.name : uid;
    const av = $('#chatAvatar');
    av.textContent = initials(name);
    avatarStyle(av, uid);
    $('#chatName').textContent = name;
    this.renderPresence();
    this.renderMessages(uid);
    this.clearUnread(uid);
    Spam.reset(uid);
    const inp = $('#msgInput');
    if (inp && window.innerWidth > 920) inp.focus();
  },
  close() {
    this.active = null;
    $('#chatView').hidden = true;
    $('#emptyState').hidden = false;
    App.setChatOpen(false);
  },
  renderPresence() {
    const el = $('#chatPresence');
    if (!el || !this.active) return;
    const on = Presence.isOnline(this.active);
    el.textContent = on ? 'en línea' : 'desconectado';
    el.classList.toggle('on', on);
  },

  /* ================= envío ================= */
  sendText() {
    const inp = $('#msgInput');
    const text = (inp.value || '').replace(/\s+$/, '');
    if (!text.trim() || !this.active) return;
    const f = this.active;
    const id = rid();
    const ts = Date.now();

    const ok = Mqtt.publish(
      T.dm(f, Auth.me.uid, id),
      { t: 'msg', id, from: Auth.me.uid, name: Auth.me.name, text, ts },
      { retain: true, expiry: 604800 }
    );
    if (!ok) { UI.toast('Sin conexión: el mensaje no se envió.'); return; }

    this.addHist(f, { t: 'msg', id, from: Auth.me.uid, name: Auth.me.name, text, ts, mine: true });
    this.appendBubble(f, { t: 'msg', id, from: Auth.me.uid, name: Auth.me.name, text, ts, mine: true });
    inp.value = '';
    inp.style.height = 'auto';
    App.renderConvoList();
  },

  async sendImage(file) {
    if (!file || !this.active) return;
    if (!file.type.startsWith('image/')) { UI.toast('Solo se pueden enviar imágenes.'); return; }
    if (file.size > 8 * 1024 * 1024) { UI.toast('La imagen supera 8 MB.'); return; }
    const f = this.active;
    try {
      const { b64, w, h } = await compressImage(file);
      const id = rid();
      const ts = Date.now();
      const n = Math.ceil(b64.length / CHUNK);

      for (let i = 0; i < n; i++) {
        const chunk = {
          t: 'imgc', id, i, n, from: Auth.me.uid, name: Auth.me.name, ts, w, h,
          data: b64.substr(i * CHUNK, CHUNK)
        };
        Mqtt.publish(T.dmc(f, Auth.me.uid, id, i), chunk, { retain: true, expiry: 604800 });
        if (i % 3 === 2) await sleep(30); /* no saturar el broker */
      }

      const blob = b64ToBlob(b64);
      await IDB.put(id, blob);

      const m = { t: 'img', id, from: Auth.me.uid, name: Auth.me.name, ts, mine: true, w, h };
      this.addHist(f, m);
      this.appendBubble(f, m);
      App.renderConvoList();
    } catch (e) {
      console.warn('sendImage', e);
      UI.toast('No se pudo procesar la imagen.');
    }
  },

  typingThrottle() {
    if (!this.active) return;
    const now = Date.now();
    if (now - this._lastTypingSent < 2200) return;
    this._lastTypingSent = now;
    Mqtt.publish(T.evt(this.active), { t: 'typing', from: Auth.me.uid, name: Auth.me.name });
  },

  /* ================= recepción ================= */
  handleIncoming(from, rest, m) {
    if (!m || !m.t || from === Auth.me.uid) return;

    if (m.t === 'msg') {
      if (rest.length !== 1) return;
      const id = rest[0] || m.id;
      if (this.hasMsg(from, id)) { this.clearTopic(T.dm(Auth.me.uid, from, id)); return; }

      const res = Spam.check(from, m.text);
      const msg = {
        t: 'msg', id, from, name: m.name || from, text: String(m.text || ''), ts: m.ts || Date.now(),
        mine: false, spam: res.isSpam, spamReasons: res.reasons, spamScore: res.score
      };
      this.addHist(from, msg);
      this.renderIncoming(from, msg);
      Notify.onIncomingMessage(from, msg, res);
      Mqtt.publish(T.evt(from), { t: 'ack', id, from: Auth.me.uid });
      this.clearTopic(T.dm(Auth.me.uid, from, id));
    }
    else if (m.t === 'imgc') {
      if (rest.length !== 2) return;
      this.onImageChunk(from, rest[0], parseInt(rest[1], 10) || 0, m);
    }
  },

  onImageChunk(from, id, i, m) {
    let buf = this._chunkBuf[id];
    if (!buf) {
      if (this.hasMsg(from, id)) { /* ya procesada: ir limpiando chunks sueltos */
        this.clearTopic(T.dmc(Auth.me.uid, from, id, i));
        return;
      }
      buf = this._chunkBuf[id] = {
        from, n: m.n || 0,
        meta: { name: m.name || from, ts: m.ts || Date.now(), w: m.w, h: m.h },
        chunks: {}
      };
    }
    if (m.n) buf.n = m.n;
    buf.chunks[i] = m.data || '';

    if (buf.n > 0 && Object.keys(buf.chunks).length >= buf.n) {
      const n = buf.n;
      const meta = buf.meta;
      const b64 = Array.from({ length: n }, (_, k) => buf.chunks[k] || '').join('');
      delete this._chunkBuf[id];

      (async () => {
        try {
          const blob = b64ToBlob(b64);
          await IDB.put(id, blob);
          const res = Spam.check(from, '[imagen]');
          const msg = {
            t: 'img', id, from, name: meta.name, ts: meta.ts, w: meta.w, h: meta.h,
            mine: false, spam: res.isSpam, spamReasons: res.reasons, spamScore: res.score
          };
          this.addHist(from, msg);
          this.renderIncoming(from, msg);
          Notify.onIncomingMessage(from, msg, res);
          Mqtt.publish(T.evt(from), { t: 'ack', id, from: Auth.me.uid });
          for (let k = 0; k < n; k++) this.clearTopic(T.dmc(Auth.me.uid, from, id, k));
        } catch (e) { console.warn('img assemble', e); }
      })();
    }
  },

  clearTopic(topic) { Mqtt.publish(topic, '', { retain: true }); },

  markAcked(id) {
    if (!id) return;
    for (const f of Object.keys(this._cache)) {
      const m = this._cache[f].find((x) => x.id === id && x.mine);
      if (m) {
        m.acked = true;
        LS.set(K.hist(Auth.me.uid, f), this._cache[f]);
        const el = document.querySelector(`[data-mid="${CSS.escape(id)}"] .tick`);
        if (el) { el.classList.add('ok'); el.textContent = '✓✓'; }
        return;
      }
    }
  },

  showTyping(from, name) {
    if (this.active !== from) return;
    $('#typingRow').hidden = false;
    $('#typingName').textContent = name || from;
    clearTimeout(this._typingTimers[from]);
    this._typingTimers[from] = setTimeout(() => { $('#typingRow').hidden = true; }, 3200);
  },

  /* ================= render ================= */
  renderIncoming(from, msg) {
    if (this.active === from) {
      this.appendBubble(from, msg);
      if (!document.hidden) this.clearUnread(from);
    }
    App.renderConvoList();
  },

  renderMessages(f) {
    const box = $('#messages');
    box.innerHTML = '';
    const h = this.hist(f);
    let prev = null;
    const frag = [];
    h.forEach((m) => {
      if (!prev || !sameDay(prev.ts, m.ts)) frag.push(`<div class="date-sep">${fmtDayLong(m.ts)}</div>`);
      frag.push(bubbleHTML(m, prev));
      prev = m;
    });
    box.innerHTML = frag.join('');
    this.hydrateImages(box);
    box.scrollTop = box.scrollHeight;
  },

  appendBubble(f, m) {
    const box = $('#messages');
    if (!box) return;
    const h = this.hist(f);
    const prev = h.length > 1 ? h[h.length - 2] : null;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    let html = '';
    if (!prev || !sameDay(prev.ts, m.ts)) html += `<div class="date-sep">${fmtDayLong(m.ts)}</div>`;
    html += bubbleHTML(m, prev);
    box.insertAdjacentHTML('beforeend', html);
    this.hydrateImages(box);
    if (nearBottom || m.mine) box.scrollTop = box.scrollHeight;
  },

  hydrateImages(scope) {
    $$('.msg-img[data-img]', scope).forEach((el) => {
      const id = el.dataset.img;
      if (this._objUrls[id]) { el.src = this._objUrls[id]; return; }
      IDB.get(id).then((blob) => {
        if (!blob) {
          const p = document.createElement('p');
          p.className = 'img-missing';
          p.textContent = 'Imagen no disponible en este dispositivo';
          el.replaceWith(p);
          return;
        }
        const u = URL.createObjectURL(blob);
        this._objUrls[id] = u;
        el.src = u;
      }).catch(() => {});
    });
  }
};

/* ---- plantilla de burbuja ---- */
function bubbleHTML(m, prev) {
  const mine = !!m.mine;
  const time = fmtTime(m.ts);
  const grp = prev && prev.mine === mine && (m.ts - prev.ts) < 240000 ? 'grp' : '';
  const spamAttr = m.spam ? ` title="Motivos: ${esc((m.spamReasons || []).join(' · ') || 'patrón de spam')}"` : '';

  if (m.t === 'img') {
    return `<div class="msg-row ${mine ? 'mine' : 'theirs'}" data-mid="${esc(m.id)}">
      <div class="bubble img ${m.spam ? 'spam' : ''}"${spamAttr}>
        <img class="msg-img" data-img="${esc(m.id)}" alt="Imagen compartida">
        ${m.spam ? `<div class="spam-chip"><svg class="icon"><use href="#i-shield"/></svg>Spam — notificación bloqueada</div>` : ''}
        <span class="msg-time">${time}</span>
      </div>
    </div>`;
  }

  return `<div class="msg-row ${mine ? 'mine' : 'theirs'} ${grp}" data-mid="${esc(m.id)}">
    <div class="bubble ${m.spam ? 'spam' : ''}"${spamAttr}>
      <p class="msg-text">${linkify(esc(m.text))}</p>
      ${m.spam ? `<div class="spam-chip"><svg class="icon"><use href="#i-shield"/></svg>Spam — notificación bloqueada</div>` : ''}
      ${mine ? `<span class="tick ${m.acked ? 'ok' : ''}">${m.acked ? '✓✓' : '✓'}</span>` : ''}
      <span class="msg-time">${time}</span>
    </div>
  </div>`;
}
