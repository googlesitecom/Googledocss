/* chat.js — mensajería real (DM + grupos)
   - Texto: tema único por mensaje, retenido + expiración 7 días (bandeja offline)
   - Imágenes y MENSAJES DE VOZ: compresión + transferencia por chunks + IndexedDB
   - Grupos: mismos mecanismos sobre nexo/v1/gm/<gid>/<autor>/<id>
   - Acuses de recibo (✓✓) en DM, indicador de escritura, historial local
   - PUSH: si el destinatario está desconectado, su navegador recibe una
     notificación Web Push aunque la app esté cerrada (ver push.js);
     el spam detectado en origen NO genera push.                          */
'use strict';

const CHUNK = 48000; /* caracteres base64 por publicacion */

function b64ToBlob(b64, type = 'image/jpeg') {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
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
  active: null,      /* uid amigo | 'g:<gid>' grupo */
  _cache: {},        /* chatKey -> [mensajes] */
  _chunkBuf: {},     /* msgId -> {key, from, n, meta, chunks} */
  _typingTimers: {},
  _lastTypingSent: 0,
  _objUrls: {},
  _voice: {},        /* msgId -> {audio, btn, wave, durEl} */
  _pushPending: new Map(), /* msgId -> {targets:Set<uid>, title, body, route, timer} */

  /* ================= tipo de chat ================= */
  kind(key) {
    if (typeof key === 'string' && key.startsWith('g:')) {
      return { type: 'group', gid: key.slice(2), group: Groups.get(key.slice(2)) };
    }
    return { type: 'dm', uid: key };
  },

  /* ================= historial ================= */
  hist(f) {
    if (!this._cache[f]) {
      this._cache[f] = LS.get(K.hist(Auth.me.uid, f), []);
      /* cronología garantizada también con historiales antiguos */
      if (this._cache[f].length > 1) this._cache[f].sort((a, b) => a.ts - b.ts);
    }
    return this._cache[f];
  },
  addHist(f, m) {
    const h = this.hist(f);
    h.push(m);
    /* orden cronológico (la entrega retenida puede llegar desordenada) */
    if (h.length > 1 && h[h.length - 2].ts > m.ts) h.sort((a, b) => a.ts - b.ts);
    if (h.length > 400) h.splice(0, h.length - 400);
    LS.set(K.hist(Auth.me.uid, f), h);
  },
  hasMsg(f, id) { return this.hist(f).some((m) => m.id === id); },
  lastMsg(f) { const h = this.hist(f); return h.length ? h[h.length - 1] : null; },
  lastActivity(f) {
    const m = this.lastMsg(f);
    if (m && m.ts) return m.ts;
    if (String(f).startsWith('g:')) {
      const g = Groups.get(f.slice(2));
      return (g && g.created) || 0;
    }
    const fr = Friends.friend(f);
    return (fr && fr.since) || 0;
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
  open(key) {
    this.active = key;
    App.setChatOpen(true);
    $('#chatView').hidden = false;
    $('#emptyState').hidden = true;
    if (typeof Stickers !== 'undefined' && Stickers.closePicker) Stickers.closePicker();
    this.renderHeaderInfo(key);
    this.renderMessages(key);
    this.clearUnread(key);
    if (this.kind(key).type === 'dm') Spam.reset(key);
    const inp = $('#msgInput');
    if (inp && window.innerWidth > 920) inp.focus();
  },
  close() {
    this.active = null;
    $('#chatView').hidden = true;
    $('#emptyState').hidden = false;
    App.setChatOpen(false);
  },

  /* cabecera del chat según DM o grupo */
  renderHeaderInfo(key) {
    const k = this.kind(key);
    const av = $('#chatAvatar');
    $('#chatView').dataset.chatType = k.type;
    if (k.type === 'group') {
      av.innerHTML = `<span class="g-mark"><svg class="icon"><use href="#i-users"/></svg></span>`;
      avatarStyle(av, k.gid);
      $('#chatName').textContent = (k.group && k.group.name) || 'Grupo';
      const n = k.group ? k.group.members.length : 0;
      const online = Groups.onlineCount(k.gid);
      const el = $('#chatPresence');
      el.textContent = `grupo · ${n} miembro${n !== 1 ? 's' : ''}${online ? ` · ${online} en línea` : ''}`;
      el.classList.remove('on');
      el.classList.add('grp');
    } else {
      av.innerHTML = Avatars.html(key, Friends.name(key));
      avatarStyle(av, key);
      $('#chatName').textContent = Friends.name(key);
      const el = $('#chatPresence');
      el.classList.remove('grp');
      const on = Presence.isOnline(key);
      el.textContent = on ? 'en línea' : Presence.lastSeenTxt ? Presence.lastSeenTxt(key) : 'desconectado';
      el.classList.toggle('on', on);
    }
  },
  renderPresence() {
    if (this.active) this.renderHeaderInfo(this.active);
  },

  /* ================= envío (DM y grupo) ================= */
  msgTopic(key, id) {
    const k = this.kind(key);
    return k.type === 'group' ? T.gm(k.gid, Auth.me.uid, id) : T.dm(key, Auth.me.uid, id);
  },
  chunkTopic(key, id, i) {
    const k = this.kind(key);
    return k.type === 'group' ? T.gmc(k.gid, Auth.me.uid, id, i) : T.dmc(key, Auth.me.uid, id, i);
  },
  typingTopic(key) {
    const k = this.kind(key);
    return k.type === 'group' ? T.gsys(k.gid, Auth.me.uid) : T.evt(key);
  },

  sendText() {
    const inp = $('#msgInput');
    const text = (inp.value || '').replace(/\s+$/, '');
    if (!text.trim() || !this.active) return;
    const key = this.active;
    const id = rid();
    const ts = Date.now();

    const ok = Mqtt.publish(
      this.msgTopic(key, id),
      { t: 'msg', id, from: Auth.me.uid, name: Auth.me.name, text, ts },
      { retain: true, expiry: 604800 }
    );
    if (!ok) { UI.toast('Sin conexión: el mensaje no se envió.'); return; }

    const m = { t: 'msg', id, from: Auth.me.uid, name: Auth.me.name, text, ts, mine: true };
    this.addHist(key, m);
    this.appendBubble(key, m);
    inp.value = '';
    inp.style.height = 'auto';
    App.renderConvoList();
    this.afterSend(key, m);
  },

  /* push a quien no pueda ver el mensaje + anti-spam en origen
     ----------------------------------------------------------------
     Estrategia "acuse de recibo":
     - Destinatario DESCONECTADO → push inmediato (no va a ack-ear).
     - Destinatario conectado → se espera 8 s por su ack (también con la
       pestaña oculta pero viva). Sin ack = pestaña cerrada/congelada
       → push. Con ack = la app lo recibió y ya avisó por su cuenta
       → nada de spam. El spam detectado en origen nunca genera push.  */
  afterSend(key, m) {
    const preview = m.t === 'img' ? 'Imagen' : m.t === 'voice' ? 'Mensaje de voz' : m.t === 'stk' ? 'Sticker' : truncate(m.text, 60);
    const res = Spam.check('out:' + Auth.me.uid, m.t === 'msg' ? m.text : preview);
    if (res.isSpam && Settings.spam) return; /* spam: sin push */

    const k = this.kind(key);
    const targets = k.type === 'dm' ? [key] : (k.group ? k.group.members.filter((u) => u !== Auth.me.uid) : []);
    const pending = new Set();
    targets.forEach((u) => {
      if (!Presence.isOnline(u)) {
        /* offline: notificar ya (no va a acusar recibo) */
        this._doPush(u, key, preview);
      } else {
        /* online: esperar su ack 8 s */
        pending.add(u);
      }
    });
    if (pending.size) {
      const entry = {
        targets: pending, key, preview,
        timer: setTimeout(() => this._flushPush(m.id), 8000)
      };
      this._pushPending.set(m.id, entry);
    }
  },

  _doPush(uid, key, preview) {
    const k = this.kind(key);
    const title = k.type === 'dm'
      ? `${Auth.me.name} te escribió`
      : `${Auth.me.name} · ${(k.group && k.group.name) || 'grupo'}`;
    Push.notify(uid, title, preview, { chat: key });
  },

  /* venció la espera de acks → push a quien no confirmó */
  _flushPush(id) {
    const e = this._pushPending.get(id);
    if (!e) return;
    this._pushPending.delete(id);
    e.targets.forEach((u) => this._doPush(u, e.key, e.preview));
  },

  /* llega el ack de un DM (1:1): el destinatario lo recibió vivo */
  ackFrom(uid, id) {
    const e = this._pushPending.get(id);
    if (e) {
      e.targets.delete(uid);
      if (!e.targets.size) {
        clearTimeout(e.timer);
        this._pushPending.delete(id);
      }
    }
  },

  /* ---------- imágenes ---------- */
  async sendImage(file) {
    if (!file || !this.active) return;
    if (!file.type.startsWith('image/')) { UI.toast('Solo se pueden enviar imágenes.'); return; }
    if (file.size > 8 * 1024 * 1024) { UI.toast('La imagen supera 8 MB.'); return; }
    const key = this.active;
    try {
      const { b64, w, h } = await compressImage(file);
      const m = await this.sendChunked(key, { b64, msgT: 'img', meta: { w, h } });
      App.renderConvoList();
      this.afterSend(key, m);
    } catch (e) {
      console.warn('sendImage', e);
      UI.toast('No se pudo procesar la imagen.');
    }
  },

  /* ---------- mensajes de voz ---------- */
  async sendVoice(blob, durSec) {
    if (!blob || !this.active) return;
    if (blob.size > 1.6 * 1024 * 1024) { UI.toast('El mensaje de voz es demasiado largo.'); return; }
    const key = this.active;
    try {
      const b64 = await blobToB64(blob);
      const m = await this.sendChunked(key, {
        b64, msgT: 'voice',
        meta: { dur: durSec, mime: blob.type || 'audio/webm' },
        blobType: blob.type || 'audio/webm'
      });
      App.renderConvoList();
      this.afterSend(key, m);
    } catch (e) {
      console.warn('sendVoice', e);
      UI.toast('No se pudo enviar el mensaje de voz.');
    }
  },

  /* ---------- envío por chunks común (imagen / voz / sticker) ---------- */
  async sendChunked(key, { b64, msgT, meta = {}, blobType = 'image/jpeg' }) {
    const id = rid();
    const ts = Date.now();
    const n = Math.ceil(b64.length / CHUNK);
    for (let i = 0; i < n; i++) {
      const chunk = {
        t: msgT === 'img' ? 'imgc' : msgT === 'voice' ? 'voic' : 'stkc', id, i, n,
        from: Auth.me.uid, name: Auth.me.name, ts,
        ...meta,
        data: b64.substr(i * CHUNK, CHUNK)
      };
      Mqtt.publish(this.chunkTopic(key, id, i), chunk, { retain: true, expiry: 604800 });
      if (i % 3 === 2) await sleep(30);
    }
    await IDB.put(id, new Blob([b64ToBlob(b64, blobType)], { type: blobType }));
    const m = { t: msgT, id, from: Auth.me.uid, name: Auth.me.name, ts, mine: true, ...meta };
    this.addHist(key, m);
    this.appendBubble(key, m);
    return m;
  },

  typingThrottle() {
    if (!this.active) return;
    const now = Date.now();
    if (now - this._lastTypingSent < 2200) return;
    this._lastTypingSent = now;
    const k = this.kind(this.active);
    if (k.type === 'group') {
      Mqtt.publish(this.typingTopic(this.active), { t: 'gtyping', from: Auth.me.uid, name: Auth.me.name });
    } else {
      Mqtt.publish(T.evt(this.active), { t: 'typing', from: Auth.me.uid, name: Auth.me.name });
    }
  },

  /* ================= recepción DM ================= */
  handleIncoming(from, rest, m) {
    if (!m || !m.t || from === Auth.me.uid) return;
    if (m.t === 'msg') {
      if (rest.length !== 1) return;
      const id = rest[0] || m.id;
      if (this.hasMsg(from, id)) { this.clearTopic(T.dm(Auth.me.uid, from, id)); return; }

      const res = Spam.check(from, m.text, m.ts || Date.now());
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
      this.onChunk(from, from, rest[0], parseInt(rest[1], 10) || 0, m, 'img');
    }
    else if (m.t === 'voic') {
      if (rest.length !== 2) return;
      this.onChunk(from, from, rest[0], parseInt(rest[1], 10) || 0, m, 'voice');
    }
    else if (m.t === 'stkc') {
      if (rest.length !== 2) return;
      this.onChunk(from, from, rest[0], parseInt(rest[1], 10) || 0, m, 'stk');
    }
  },

  /* ================= recepción GRUPO ================= */
  handleGroupIncoming(gid, from, rest, m) {
    if (!m || !m.t) return;
    if (m.t === 'gcalle') { if (typeof Calls !== 'undefined') Calls.onGroupEvt(gid, m); return; }
    if (from === Auth.me.uid) return;
    const key = 'g:' + gid;
    if (m.t === 'gtyping') { this.showTyping(key, m.name || from); return; }
    if (m.t === 'msg') {
      if (rest.length !== 1) return;
      const id = rest[0] || m.id;
      if (this.hasMsg(key, id)) { this.clearTopic(T.gm(gid, from, id)); return; }

      const res = Spam.check(from, m.text, m.ts || Date.now());
      const msg = {
        t: 'msg', id, from, name: m.name || from, gname: Groups.name(gid), text: String(m.text || ''),
        ts: m.ts || Date.now(), mine: false, spam: res.isSpam, spamReasons: res.reasons, spamScore: res.score
      };
      this.addHist(key, msg);
      this.renderIncoming(key, msg);
      Notify.onIncomingMessage(key, msg, res, from);
      /* ack al autor para su push diferido (y estadística futura) */
      Mqtt.publish(T.evt(from), { t: 'gack', gid, id, from: Auth.me.uid });
      this.clearTopic(T.gm(gid, from, id));
    }
    else if (m.t === 'imgc' || m.t === 'voic' || m.t === 'stkc') {
      if (rest.length !== 2) return;
      this.onChunk(key, from, rest[0], parseInt(rest[1], 10) || 0, m, m.t === 'imgc' ? 'img' : m.t === 'voic' ? 'voice' : 'stk');
    }
  },

  /* ---------- chunks comunes (key = chat, from = autor) ---------- */
  onChunk(key, from, id, i, m, kindT) {
    let buf = this._chunkBuf[id];
    if (!buf) {
      if (this.hasMsg(key, id)) { this.clearTopic(this.chunkTopicOf(key, from, id, i)); return; }
      buf = this._chunkBuf[id] = {
        key, from, n: m.n || 0,
        meta: kindT === 'voice'
          ? { name: m.name || from, ts: m.ts || Date.now(), dur: m.dur || 0, mime: m.mime || 'audio/webm' }
          : kindT === 'stk'
            ? { name: m.name || from, ts: m.ts || Date.now(), w: m.w, h: m.h, mime: m.mime || 'image/webp' }
            : { name: m.name || from, ts: m.ts || Date.now(), w: m.w, h: m.h },
        kindT,
        chunks: {}
      };
    }
    if (m.n) buf.n = m.n;
    buf.chunks[i] = m.data || '';

    if (buf.n > 0 && Object.keys(buf.chunks).length >= buf.n) {
      const { n, meta, kindT: type } = buf;
      const b64 = Array.from({ length: n }, (_, k) => buf.chunks[k] || '').join('');
      delete this._chunkBuf[id];

      (async () => {
        try {
          const blobType = type === 'voice' ? (meta.mime || 'audio/webm') : type === 'stk' ? (meta.mime || 'image/webp') : 'image/jpeg';
          const blob = b64ToBlob(b64, blobType);
          await IDB.put(id, blob);
          const label = type === 'img' ? '[imagen]' : type === 'stk' ? '[sticker]' : '[mensaje de voz]';
          const res = Spam.check(from, label, meta.ts || Date.now());
          const msg = {
            t: type, id, from, name: meta.name, ts: meta.ts, mine: false,
            spam: res.isSpam, spamReasons: res.reasons, spamScore: res.score
          };
          if (type === 'img') { msg.w = meta.w; msg.h = meta.h; }
          else if (type === 'stk') { msg.w = meta.w; msg.h = meta.h; msg.mime = meta.mime; }
          else { msg.dur = meta.dur; msg.mime = meta.mime; }
          const k = this.kind(key);
          if (k.type === 'group') msg.gname = Groups.name(k.gid);
          this.addHist(key, msg);
          this.renderIncoming(key, msg);
          Notify.onIncomingMessage(key, msg, res, from);
          /* ack al autor (DM) o gack (grupo): cancela su push diferido */
          if (k.type === 'group') Mqtt.publish(T.evt(from), { t: 'gack', gid: k.gid, id, from: Auth.me.uid });
          else Mqtt.publish(T.evt(from), { t: 'ack', id, from: Auth.me.uid });
          for (let c = 0; c < n; c++) this.clearTopic(this.chunkTopicOf(key, from, id, c));
        } catch (e) { console.warn('assemble', e); }
      })();
    }
  },

  chunkTopicOf(key, from, id, i) {
    const k = this.kind(key);
    /* los chunks llegan al destinatario: dm/<YO>/<autor>/... */
    return k.type === 'group' ? T.gmc(k.gid, from, id, i) : T.dmc(Auth.me.uid, from, id, i);
  },

  clearTopic(topic) { Mqtt.publish(topic, '', { retain: true }); },

  markAcked(id, fromUid) {
    if (!id) return;
    /* cancela el push diferido de ese destinatario */
    if (fromUid) this.ackFrom(fromUid, id);
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

  showTyping(key, name) {
    if (this.active !== key) return;
    $('#typingRow').hidden = false;
    $('#typingName').textContent = name || '';
    clearTimeout(this._typingTimers[key]);
    this._typingTimers[key] = setTimeout(() => { $('#typingRow').hidden = true; }, 3200);
  },

  /* ================= render ================= */
  renderIncoming(key, msg) {
    if (this.active === key) {
      this.appendBubble(key, msg);
      if (!document.hidden) this.clearUnread(key);
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
      frag.push(bubbleHTML(m, prev, f));
      prev = m;
    });
    box.innerHTML = frag.join('');
    this.hydrateMedia(box);
    this.applyWallpaper();
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
    html += bubbleHTML(m, prev, f);
    box.insertAdjacentHTML('beforeend', html);
    this.hydrateMedia(box);
    if (nearBottom || m.mine) box.scrollTop = box.scrollHeight;
  },

  hydrateMedia(scope) {
    /* imágenes y stickers */
    $$('.msg-img[data-img], .msg-stk[data-img]', scope).forEach((el) => {
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
    /* ondas de voz */
    $$('.v-wave[data-vid]', scope).forEach((el) => this.hydrateWave(el));
  },

  async hydrateWave(el) {
    const id = el.dataset.vid;
    if (el.dataset.done) return;
    /* buscar picos ya calculados en el historial */
    let peaks = null;
    for (const f of Object.keys(this._cache)) {
      const m = this._cache[f].find((x) => x.id === id);
      if (m) {
        if (m.peaks) peaks = m.peaks;
        else {
          const blob = await IDB.get(id);
          if (blob) {
            peaks = await Voice.peaks(blob);
            m.peaks = peaks;
            LS.set(K.hist(Auth.me.uid, f), this._cache[f]);
          }
        }
        break;
      }
    }
    if (!peaks) peaks = Array.from({ length: 26 }, () => 0.4);
    el.dataset.done = '1';
    [...el.children].forEach((bar, i) => {
      bar.style.height = (7 + (peaks[i] || 0.3) * 24).toFixed(1) + 'px';
    });
  },

  applyWallpaper() { if (typeof Theme !== 'undefined' && Theme.applyWallpaper) Theme.applyWallpaper(); },

  /* ================= reproductor de voz ================= */
  async toggleVoice(id, btn) {
    let p = this._voice[id];
    if (!p) {
      const blob = await IDB.get(id);
      if (!blob) { UI.toast('Audio no disponible en este dispositivo.'); return; }
      const audio = new Audio(URL.createObjectURL(blob));
      p = this._voice[id] = { audio, btn };
      audio.addEventListener('timeupdate', () => this._voiceTick(id));
      audio.addEventListener('ended', () => {
        const b = p.btn;
        if (b) b.innerHTML = '<svg class="icon"><use href="#i-play"/></svg>';
        this._voiceTick(id, true);
      });
    }
    /* pausar los demás */
    Object.entries(this._voice).forEach(([oid, o]) => {
      if (oid !== id && o.audio && !o.audio.paused) {
        o.audio.pause();
        const b = o.btn || document.querySelector(`.v-play[data-vid="${CSS.escape(oid)}"]`);
        if (b) b.innerHTML = '<svg class="icon"><use href="#i-play"/></svg>';
      }
    });
    if (p.audio.paused) {
      p.btn = btn;
      p.audio.play().catch(() => UI.toast('No se pudo reproducir el audio.'));
      btn.innerHTML = '<svg class="icon"><use href="#i-pause"/></svg>';
    } else {
      p.audio.pause();
      btn.innerHTML = '<svg class="icon"><use href="#i-play"/></svg>';
    }
  },

  _voiceTick(id, reset) {
    const p = this._voice[id];
    if (!p) return;
    const dur = isFinite(p.audio.duration) && p.audio.duration > 0 ? p.audio.duration : null;
    const cur = reset ? 0 : p.audio.currentTime;
    const el = document.querySelector(`.v-dur[data-vid="${CSS.escape(id)}"]`);
    if (el) el.textContent = Voice.fmtDur((dur || 0) - cur > 0 ? (dur - cur) : (dur || 0)) + (reset ? '' : '');
    if (reset) el && (el.textContent = Voice.fmtDur(dur || 0));
    const ratio = dur ? Math.min(1, cur / dur) : 0;
    const wave = document.querySelector(`.v-wave[data-vid="${CSS.escape(id)}"]`);
    if (wave) {
      const bars = wave.children;
      const played = Math.round(ratio * bars.length);
      for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('played', i < played);
    }
  },

  cycleVoiceSpeed(id, btn) {
    const p = this._voice[id];
    if (!p) return;
    const next = p.audio.playbackRate >= 2 ? 1 : p.audio.playbackRate >= 1.5 ? 2 : 1.5;
    p.audio.playbackRate = next;
    btn.textContent = next + 'x';
  }
};

/* ---- plantilla de burbuja ---- */
function bubbleHTML(m, prev, chatKey) {
  const mine = !!m.mine;
  const time = fmtTime(m.ts);
  const grp = prev && prev.mine === mine && prev.from === m.from && (m.ts - prev.ts) < 240000 ? 'grp' : '';
  const spamAttr = m.spam ? ` title="Motivos: ${esc((m.spamReasons || []).join(' · ') || 'patrón de spam')}"` : '';
  const isGroup = typeof chatKey === 'string' && chatKey.startsWith('g:');

  /* en grupos: avatar + nombre de QUIEN ENVÍA en cada mensaje ajeno
     (clicables → ver perfil) */
  const showAvatar = isGroup && !mine && (!prev || prev.from !== m.from || prev.mine);
  const sender = isGroup && !mine
    ? `<span class="g-sender" style="--sh:${hueOf(m.from || '')}" data-puid="${esc(m.from || '')}" role="button" tabindex="0" title="Ver perfil">${esc(m.name || m.from || '')}</span>` : '';
  const avatar = showAvatar
    ? `<div class="avatar msg-av" style="--h:${hueOf(m.from || '')}" data-puid="${esc(m.from || '')}" title="Ver perfil de ${esc(m.name || m.from || '')}">${Avatars.html(m.from, m.name || m.from)}</div>` : '';
  const inner = `${avatar}<div class="msg-col">${sender}`;

  const tick = mine && !isGroup ? `<span class="tick ${m.acked ? 'ok' : ''}">${m.acked ? '✓✓' : '✓'}</span>` : (mine ? '<span class="tick">✓</span>' : '');
  const spamChip = m.spam ? `<div class="spam-chip"><svg class="icon"><use href="#i-shield"/></svg>Spam — notificación bloqueada</div>` : '';

  /* sticker: grande, sin burbuja (estilo WhatsApp) + ★ para guardarlo en favoritos */
  if (m.t === 'stk') {
    return `<div class="msg-row ${mine ? 'mine' : 'theirs'} ${grp}" data-mid="${esc(m.id)}">${inner}
      <div class="stk-wrap"${spamAttr}>
        <img class="msg-stk" data-img="${esc(m.id)}" alt="Sticker" loading="lazy">
        ${mine ? '' : `<button class="stk-fav" data-fav="${esc(m.id)}" title="Guardar en mis stickers favoritos"><svg class="icon"><use href="#i-star"/></svg></button>`}
        ${spamChip}
        ${tick}
        <span class="msg-time">${time}</span>
      </div>
    </div></div>`;
  }

  if (m.t === 'img') {
    return `<div class="msg-row ${mine ? 'mine' : 'theirs'}" data-mid="${esc(m.id)}">${inner}
      <div class="bubble img ${m.spam ? 'spam' : ''}"${spamAttr}>
        <img class="msg-img" data-img="${esc(m.id)}" alt="Imagen compartida">
        ${spamChip}
        <span class="msg-time">${time}</span>
      </div>
    </div></div>`;
  }

  if (m.t === 'voice') {
    return `<div class="msg-row ${mine ? 'mine' : 'theirs'}" data-mid="${esc(m.id)}">${inner}
      <div class="bubble voice ${m.spam ? 'spam' : ''}"${spamAttr}>
        <div class="v-row">
          <button class="v-play" data-vid="${esc(m.id)}" title="Reproducir"><svg class="icon"><use href="#i-play"/></svg></button>
          <span class="v-wave" data-vid="${esc(m.id)}">${'<i></i>'.repeat(26)}</span>
          <span class="v-dur" data-vid="${esc(m.id)}">${Voice.fmtDur(m.dur || 0)}</span>
          <button class="v-speed" data-vid="${esc(m.id)}" title="Velocidad">1x</button>
        </div>
        ${spamChip}
        ${tick}
        <span class="msg-time">${time}</span>
      </div>
    </div></div>`;
  }

  return `<div class="msg-row ${mine ? 'mine' : 'theirs'} ${grp}" data-mid="${esc(m.id)}">${inner}
    <div class="bubble ${m.spam ? 'spam' : ''}"${spamAttr}>
      <p class="msg-text">${linkify(esc(m.text))}</p>
      ${spamChip}
      ${tick}
      <span class="msg-time">${time}</span>
    </div>
  </div></div>`;
}
