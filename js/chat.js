/* chat.js — mensajería real (DM + grupos)
   - Texto: tema único por mensaje, retenido + expiración 7 días (bandeja offline)
   - Imágenes y MENSAJES DE VOZ: compresión + transferencia por chunks + IndexedDB
   - Grupos: mismos mecanismos sobre nexo/v1/gm/<gid>/<autor>/<id>
   - Acuses de recibo (✓✓) en DM, indicador de escritura, historial local
   - v6 FUNCIONES WHATSAPP: responder (citas), reacciones con emoji,
     eliminar para todos, copiar, reenviar, silenciar chats, fijar chats,
     buscar dentro del chat y menú contextual (clic ⋮ / clic derecho /
     pulsación larga)
   - RETENCIÓN DE GRUPO: los mensajes de grupo NUNCA se borran del broker
     al recibirlos (solo expiran a los 7 días): con varios miembros,
     el primero en conectarse ya no roba la copia retenida al resto.
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

/* ---- chips de reacción (agregados por emoji, el propio resaltado) ---- */
function rxChipsHTML(m) {
  const rx = m.rx || {};
  const keys = Object.keys(rx);
  if (!keys.length) return '';
  const agg = {};
  keys.forEach((u) => { agg[rx[u]] = (agg[rx[u]] || 0) + 1; });
  const mine = rx[Auth.me.uid];
  return `<div class="rx-row">${Object.entries(agg).map(([e, n]) => `
    <button class="rx-chip ${mine === e ? 'mine' : ''}" data-rx="${esc(e)}" title="${mine === e ? 'Quitar tu reacción' : 'Reaccionar con ' + esc(e)}">${e}${n > 1 ? `<b>${n}</b>` : ''}</button>`).join('')}</div>`;
}

/* ---- posición del menú contextual junto a su ancla ---- */
function positionCtxMenu(menu, anchor) {
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = r.left + (r.width / 2) - (mw / 2);
  x = Math.max(10, Math.min(x, window.innerWidth - mw - 10));
  let y = r.bottom + 6;
  if (y + mh > window.innerHeight - 10) y = Math.max(10, r.top - mh - 6);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

/* ---- menú contextual de MENSAJE (estilo WhatsApp Web) ---- */
const MsgMenu = {
  key: null, mid: null,
  EMOJIS: ['❤️', '😂', '👍', '😮', '😢', '🙏', '🔥'],
  open(key, mid, anchor) {
    if (!key || !mid || !Auth.me) return;
    const m = (Chat.hist(key) || []).find((x) => x.id === mid);
    if (!m) return;
    this.key = key; this.mid = mid;
    window.__lpAt = Date.now(); /* suprimir el clic posterior a la pulsación larga */
    const menu = $('#ctxMenu');
    const myRx = m.rx && m.rx[Auth.me.uid];
    const rxEls = this.EMOJIS.map((e) =>
      `<button class="ctx-rx ${myRx === e ? 'sel' : ''}" data-mrx="${esc(e)}" title="${esc(e)}">${e}</button>`).join('')
      + (myRx ? `<button class="ctx-rx" data-mrx="" title="Quitar mi reacción">✖️</button>` : '');
    let items = `<button class="ctx-item" data-mact="reply"><svg class="icon"><use href="#i-reply"/></svg>Responder</button>`;
    if (m.t === 'msg' && !m.deleted) items += `
      <button class="ctx-item" data-mact="copy"><svg class="icon"><use href="#i-copy"/></svg>Copiar texto</button>
      <button class="ctx-item" data-mact="fwd"><svg class="icon"><use href="#i-forward"/></svg>Reenviar</button>`;
    if (m.mine && !m.deleted) items += `
      <button class="ctx-item danger" data-mact="del"><svg class="icon"><use href="#i-trash"/></svg>Eliminar para todos</button>`;
    menu.innerHTML = `<div class="ctx-reactions">${rxEls}</div><div id="ctxItems">${items}</div>`;
    positionCtxMenu(menu, anchor);
  },
  close() {
    const menu = $('#ctxMenu');
    if (menu) { menu.hidden = true; menu.innerHTML = ''; menu.style.left = menu.style.top = ''; }
    this.key = this.mid = null;
  },
  act(action, emoji) {
    if (!this.key || !this.mid) return;
    const m = (Chat.hist(this.key) || []).find((x) => x.id === this.mid);
    if (!m) { this.close(); return; }
    if (emoji != null) Chat.react(this.key, this.mid, emoji);
    else if (action === 'reply') Chat.setReply(m);
    else if (action === 'copy') Chat.copyText(m);
    else if (action === 'fwd') Chat.openForward(m);
    else if (action === 'del') Chat.deleteMsg(this.key, m);
    this.close();
  }
};

/* ---- menú contextual de CONVERSACIÓN (fijar / silenciar / perfil) ---- */
const ConvoMenu = {
  key: null,
  open(key, anchor) {
    if (!key || !Auth.me) return;
    this.key = key;
    window.__lpAt = Date.now();
    const menu = $('#ctxMenu');
    const pinned = Chat.isPinned(key);
    const muted = Chat.isMuted(key);
    const isGroup = String(key).startsWith('g:');
    menu.innerHTML = `<div id="ctxItems" style="padding:2px">
      <button class="ctx-item" data-cact="pin"><svg class="icon"><use href="#i-pin"/></svg>${pinned ? 'Desfijar chat' : 'Fijar chat'}</button>
      <button class="ctx-item" data-cact="mute"><svg class="icon"><use href="#i-${muted ? 'bell' : 'bell-off'}"/></svg>${muted ? 'Reactivar notificaciones' : 'Silenciar notificaciones'}</button>
      ${isGroup ? '' : `<button class="ctx-item" data-cact="profile"><svg class="icon"><use href="#i-users"/></svg>Ver perfil</button>`}
    </div>`;
    positionCtxMenu(menu, anchor);
  },
  close() {
    const menu = $('#ctxMenu');
    if (menu) { menu.hidden = true; menu.innerHTML = ''; }
    this.key = null;
  },
  act(act) {
    if (!this.key) return;
    if (act === 'pin') Chat.togglePin(this.key);
    else if (act === 'mute') Chat.toggleMute(this.key);
    else if (act === 'profile') ProfileCard.open(this.key);
    this.close();
  }
};

const Chat = {
  active: null,      /* uid amigo | 'g:<gid>' grupo */
  _cache: {},        /* chatKey -> [mensajes] */
  _chunkBuf: {},     /* msgId -> {key, from, n, meta, chunks} */
  _typingTimers: {},
  _lastTypingSent: 0,
  _objUrls: {},
  _voice: {},        /* msgId -> {audio, btn, wave, durEl} */
  _pushPending: new Map(), /* msgId -> {targets:Set<uid>, title, body, route, timer} */
  _replyTo: null,    /* mensaje al que se está respondiendo */

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

  /* ================= silenciar / fijar ================= */
  isMuted(key) { return !!(Settings.muted && Settings.muted[key]); },
  toggleMute(key) {
    Settings.muted = Settings.muted || {};
    if (Settings.muted[key]) delete Settings.muted[key];
    else Settings.muted[key] = true;
    saveSettings();
    this.syncMuted();
    App.renderConvoList();
    UI.toast(this.isMuted(key)
      ? 'Chat silenciado: sin sonidos ni notificaciones (los mensajes siguen llegando).'
      : 'Notificaciones reactivadas.');
  },
  syncMuted() {
    try { IDB.kvSet('muted', Object.keys(Settings.muted || {})); } catch (e) {}
  },
  isPinned(key) { return !!(Settings.pinned && Settings.pinned[key]); },
  togglePin(key) {
    Settings.pinned = Settings.pinned || {};
    if (Settings.pinned[key]) delete Settings.pinned[key];
    else Settings.pinned[key] = true;
    saveSettings();
    App.renderConvoList();
  },

  /* ================= abrir / cerrar ================= */
  open(key) {
    this.active = key;
    App.setChatOpen(true);
    $('#chatView').hidden = false;
    $('#emptyState').hidden = true;
    if (typeof Stickers !== 'undefined' && Stickers.closePicker) Stickers.closePicker();
    if (typeof Emoji !== 'undefined' && Emoji.closePanel) Emoji.closePanel();
    this.clearReply();
    this.closeSearch();
    this.renderHeaderInfo(key);
    this.renderMessages(key);
    this.clearUnread(key);
    if (this.kind(key).type === 'dm') Spam.reset(key);
    /* barra de llamada de grupo en curso («Unirse») */
    if (typeof Calls !== 'undefined' && Calls.renderOngoingBar) Calls.renderOngoingBar();
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
      av.innerHTML = GroupAvatars.html(k.gid);
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

  previewOf(m) {
    if (!m) return '';
    if (m.deleted) return 'Mensaje eliminado';
    if (m.t === 'img') return 'Imagen';
    if (m.t === 'voice') return 'Mensaje de voz';
    if (m.t === 'stk') return 'Sticker';
    if (m.t === 'sys') return truncate(m.text, 64);
    return truncate(m.text, 64);
  },

  sendText() {
    const inp = $('#msgInput');
    const text = (inp.value || '').replace(/\s+$/, '');
    if (!text.trim() || !this.active) return;
    const key = this.active;
    const re = this._replyTo ? { ...this._replyTo } : undefined;
    const sent = this._sendTextTo(key, text, { re });
    if (sent) {
      inp.value = '';
      inp.style.height = 'auto';
      this.clearReply();
    }
  },

  _sendTextTo(key, text, { re, fwd } = {}) {
    const id = rid();
    const ts = Date.now();
    const payload = { t: 'msg', id, from: Auth.me.uid, name: Auth.me.name, text, ts };
    if (re) payload.re = re;
    if (fwd) payload.fwd = true;
    const ok = Mqtt.publish(this.msgTopic(key, id), payload, { retain: true, expiry: 604800 });
    if (!ok) { UI.toast('Sin conexión: el mensaje no se envió.'); return null; }
    const m = { t: 'msg', id, from: Auth.me.uid, name: Auth.me.name, text, ts, mine: true };
    if (re) m.re = re;
    if (fwd) m.fwd = true;
    this.addHist(key, m);
    if (this.active === key) this.appendBubble(key, m);
    App.renderConvoList();
    this.afterSend(key, m);
    if (Settings.sound) Sound.send();
    return m;
  },

  /* ---------- RESPONDER: barra de vista previa ---------- */
  setReply(m) {
    if (!m) return;
    this._replyTo = {
      id: m.id,
      name: m.mine ? Auth.me.name : (m.name || m.from || ''),
      text: this.previewOf(m)
    };
    const bar = $('#replyBar');
    if (!bar) return;
    $('#replyName').textContent = 'Respondiendo a ' + this._replyTo.name;
    $('#replyText').textContent = this._replyTo.text;
    bar.hidden = false;
    const inp = $('#msgInput');
    if (inp && window.innerWidth > 920) inp.focus();
  },
  clearReply() {
    this._replyTo = null;
    const bar = $('#replyBar');
    if (bar) bar.hidden = true;
  },

  /* saltar al mensaje original de una cita */
  jumpTo(mid) {
    const row = document.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
    if (!row) { UI.toast('El mensaje original ya no está disponible.'); return; }
    try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { row.scrollIntoView(); }
    row.classList.remove('msg-flash');
    void row.offsetWidth;
    row.classList.add('msg-flash');
  },

  /* ---------- REACCIONES ---------- */
  react(key, mid, emoji) {
    const h = this.hist(key);
    const msg = h.find((x) => x.id === mid);
    if (!msg) return;
    msg.rx = msg.rx || {};
    const had = msg.rx[Auth.me.uid];
    if (emoji && had === emoji) emoji = ''; /* mismo emoji → quitar */
    if (emoji) msg.rx[Auth.me.uid] = emoji;
    else delete msg.rx[Auth.me.uid];
    if (msg.rx && !Object.keys(msg.rx).length) delete msg.rx;
    LS.set(K.hist(Auth.me.uid, key), h);
    this._refreshRx(key, mid);
    const k = this.kind(key);
    const topic = k.type === 'group'
      ? T.grx(k.gid, Auth.me.uid, mid)
      : T.rx(key, Auth.me.uid, mid);
    Mqtt.publish(topic, { t: 'rx', mid, from: Auth.me.uid, name: Auth.me.name, emoji: emoji || '', ts: Date.now() }, { retain: true, expiry: 604800 });
  },

  /* llega una reacción (tema retenido rx/... DM o grx/... grupo) */
  handleReaction(chatKey, mid, m, topic) {
    if (!m || !m.from || !mid || m.from === Auth.me.uid) return;
    const h = this.hist(chatKey);
    const msg = h.find((x) => x.id === mid);
    if (!msg) {
      /* no lo tengo (historial antiguo/borrado): en DM limpiar el retenido */
      if (topic && topic.startsWith(`${NS}/rx/`)) this.clearTopic(topic);
      return;
    }
    msg.rx = msg.rx || {};
    if (m.emoji) msg.rx[m.from] = m.emoji;
    else delete msg.rx[m.from];
    if (!Object.keys(msg.rx).length) delete msg.rx;
    LS.set(K.hist(Auth.me.uid, chatKey), h);
    this._refreshRx(chatKey, mid);
    /* en DM: limpiar el retenido (yo soy el único destinatario);
       en grupo NO: los miembros desconectados aún deben recibirlo */
    if (topic && topic.startsWith(`${NS}/rx/`)) this.clearTopic(topic);
    if (msg.mine && Settings.sound && !this.isMuted(chatKey)) Sound.react();
  },

  _refreshRx(key, mid) {
    if (this.active !== key) return;
    const msg = (this.hist(key) || []).find((x) => x.id === mid);
    const row = document.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
    if (!row || !msg) return;
    const holder = row.querySelector('.bubble') || row.querySelector('.stk-wrap');
    if (!holder) return;
    const existing = holder.querySelector(':scope > .rx-row');
    const html = rxChipsHTML(msg);
    if (html) {
      if (existing) existing.outerHTML = html;
      else holder.insertAdjacentHTML('beforeend', html);
    } else if (existing) existing.remove();
  },

  /* re-render de UNA fila (p. ej. tras eliminar) */
  _refreshRow(key, mid) {
    if (this.active !== key) return;
    const h = this.hist(key);
    const i = h.findIndex((x) => x.id === mid);
    if (i < 0) return;
    const m = h[i];
    const prev = i > 0 ? h[i - 1] : null;
    const row = document.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
    if (!row) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = bubbleHTML(m, prev, key);
    row.replaceWith(wrap.firstElementChild);
    this.hydrateMedia($('#messages'));
  },

  /* ---------- ELIMINAR PARA TODOS ---------- */
  deleteMsg(key, m) {
    if (!m || !m.mine || m.deleted) return;
    const h = this.hist(key);
    const msg = h.find((x) => x.id === m.id);
    if (!msg) return;
    msg.deleted = true;
    delete msg.text; /* privacidad: no conservar el texto */
    LS.set(K.hist(Auth.me.uid, key), h);
    /* publicar la ELIMINACIÓN sobre el tema original del mensaje (retenido):
       los conectados la aplican al instante y los desconectados, al reconectar */
    const k = this.kind(key);
    const topic = k.type === 'group' ? T.gm(k.gid, Auth.me.uid, msg.id) : T.dm(key, Auth.me.uid, msg.id);
    Mqtt.publish(topic, { t: 'del', id: msg.id, from: Auth.me.uid, ts: Date.now() }, { retain: true, expiry: 604800 });
    this._refreshRow(key, msg.id);
    App.renderConvoList();
    if (Settings.sound) Sound.send();
  },

  _applyDeleted(chatKey, id) {
    if (!id) return;
    const h = this.hist(chatKey);
    const msg = h.find((x) => x.id === id);
    if (!msg || msg.deleted) return;
    msg.deleted = true;
    delete msg.text;
    LS.set(K.hist(Auth.me.uid, chatKey), h);
    this._refreshRow(chatKey, id);
    App.renderConvoList();
  },

  /* ---------- COPIAR / REENVIAR ---------- */
  copyText(m) {
    if (!m || m.deleted) return;
    const text = String(m.text || '');
    const done = () => UI.toast('Texto copiado al portapapeles.');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => this._copyFallback(text, done));
    } else this._copyFallback(text, done);
  },
  _copyFallback(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch (e) { UI.toast('No se pudo copiar el texto.'); }
  },

  forwardTo(key, m) {
    if (!m || m.deleted || m.t !== 'msg') return;
    const sent = this._sendTextTo(key, String(m.text || ''), { fwd: true });
    if (sent) {
      const k = this.kind(key);
      UI.toast(`Reenviado a ${k.type === 'group' ? (k.group && k.group.name) || 'el grupo' : Friends.name(key)}.`);
    }
  },
  openForward(m) {
    if (!m || m.t !== 'msg' || m.deleted) return;
    const targets = [
      ...Friends.all().map((f) => ({ key: f.uid, name: f.name, group: false })),
      ...Groups.all().map((g) => ({ key: 'g:' + g.id, name: g.name, group: true }))
    ];
    if (!targets.length) { UI.toast('No tienes chats a los que reenviar.'); return; }
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal group-modal">
        <h3>Reenviar mensaje</h3>
        <p>Elige el chat de destino: se enviará marcado como reenviado.</p>
        <div class="grp-list">
          ${targets.map((t) => `
            <button class="grp-pick fwd-to" data-fkey="${esc(t.key)}">
              <span class="avatar" style="--h:${hueOf(t.group ? t.key.slice(2) : t.key)}">${t.group ? GroupAvatars.html(t.key.slice(2)) : Avatars.html(t.key, t.name)}</span>
              <span class="g-info"><strong>${esc(t.name)}</strong><span>${t.group ? 'grupo' : '@' + esc(t.key)}</span></span>
            </button>`).join('')}
        </div>
        <div class="m-acts"><button class="btn-ghost" data-r="0">Cancelar</button></div>
      </div>`;
    root.hidden = false;
    root.onclick = (e) => {
      const t = e.target.closest('.fwd-to');
      if (t) { this.forwardTo(t.dataset.fkey, m); Groups.closeModal(); return; }
      if (e.target.closest('[data-r="0"]')) Groups.closeModal();
    };
  },

  /* ---------- BUSCAR dentro del chat ---------- */
  toggleSearch() {
    const bar = $('#chatSearch');
    if (!bar || !this.active) return;
    if (bar.hidden) {
      bar.hidden = false;
      const i = $('#chatSearchInput');
      if (i) i.focus();
    } else this.closeSearch();
  },
  closeSearch() {
    const bar = $('#chatSearch');
    if (!bar) return;
    const wasOpen = !bar.hidden;
    bar.hidden = true;
    const i = $('#chatSearchInput');
    if (i) i.value = '';
    const c = $('#chatSearchCount');
    if (c) c.textContent = '';
    if (wasOpen && this.active) this.renderMessages(this.active);
  },
  runSearch(q) {
    if (!this.active) return;
    const box = $('#messages');
    q = String(q || '').trim().toLowerCase();
    const count = $('#chatSearchCount');
    if (!q) {
      if (count) count.textContent = '';
      this.renderMessages(this.active);
      return;
    }
    const h = this.hist(this.active).filter((m) => !m.deleted && m.t === 'msg' && String(m.text || '').toLowerCase().includes(q));
    if (count) count.textContent = h.length ? `${h.length} resultado${h.length !== 1 ? 's' : ''}` : 'Sin resultados';
    if (!h.length) {
      box.innerHTML = `<div class="f-empty" style="margin:22px auto;max-width:280px">Ningún mensaje de esta conversación coincide con «${esc(q)}».</div>`;
      return;
    }
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    box.innerHTML = h.map((m) => {
      const hl = esc(m.text).replace(rx, (mm) => `<mark>${mm}</mark>`);
      const isGroup = String(this.active).startsWith('g:');
      const author = m.mine ? 'Tú' : (m.name || m.from || '');
      return `<div class="msg-row ${m.mine ? 'mine' : 'theirs'}" data-mid="${esc(m.id)}" style="max-width:92%">
        <div class="bubble">
          ${isGroup && !m.mine ? `<span class="g-sender" style="--sh:${hueOf(m.from || '')}">${esc(author)}</span>` : ''}
          <p class="msg-text">${hl}</p>
          <span class="msg-time">${fmtDay(m.ts)}</span>
        </div>
      </div>`;
    }).join('');
    box.scrollTop = 0;
  },

  /* ================= push a quien no pueda ver el mensaje + anti-spam en origen
     ----------------------------------------------------------------
     Estrategia "acuse de recibo":
     - Destinatario DESCONECTADO → push inmediato (no va a ack-ear).
     - Destinatario conectado → se espera 8 s por su ack (también con la
       pestaña oculta pero viva). Sin ack = pestaña cerrada/congelada
       → push. Con ack = la app lo recibió y ya avisó por su cuenta
       → nada de spam. El spam detectado en origen nunca genera push.  */
  afterSend(key, m) {
    const preview = m.fwd ? 'Reenviado: ' + this.previewOf(m) : this.previewOf(m);
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
    const re = this._replyTo ? { ...this._replyTo } : undefined;
    if (re) meta.re = re;
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
    if (this.active === key) this.appendBubble(key, m);
    if (re) this.clearReply();
    if (Settings.sound) Sound.send();
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
      if (m.re) msg.re = m.re;
      if (m.fwd) msg.fwd = true;
      this.addHist(from, msg);
      this.renderIncoming(from, msg);
      Notify.onIncomingMessage(from, msg, res);
      Mqtt.publish(T.evt(from), { t: 'ack', id, from: Auth.me.uid });
      this.clearTopic(T.dm(Auth.me.uid, from, id));
    }
    else if (m.t === 'del') {
      /* el autor eliminó su mensaje para todos */
      const id = m.id || rest[0];
      this._applyDeleted(from, id);
      this.clearTopic(T.dm(Auth.me.uid, from, id));
      return;
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
    /* mensaje de sistema del grupo (autor «sys», id propio, retenido):
       «X añadió a Y», «X cambió el nombre…», «X eliminó a Y» →
       queda en el historial de todos, también de quien conecte luego */
    if (m.t === 'gsysmsg') {
      const id = rest[0] || m.id;
      const key = 'g:' + gid;
      if (!id || this.hasMsg(key, id) || !Groups.get(gid)) return;
      const msg = { t: 'sys', id, k: m.k, from: m.from, name: m.name, text: String(m.text || ''), ts: m.ts || Date.now() };
      if (m.extra !== undefined) msg.extra = m.extra;
      this.addHist(key, msg);
      if (this.active === key) this.appendBubble(key, msg);
      App.renderConvoList();
      /* aviso discreto a quien no tenga el chat abierto (a los añadidos
         ya les llega el toast de invitación: no duplicar) */
      const aboutMe = m.k !== 'renamed' && m.extra && (
        (Array.isArray(m.extra) && m.extra.some((x) => x && x.uid === Auth.me.uid)) ||
        (m.extra.uid === Auth.me.uid));
      if (this.active !== key && !aboutMe) {
        UI.toast(truncate(m.text, 90), { icon: 'users', onClick: () => App.openChat(key) });
      }
      return;
    }
    if (m.t === 'del') {
      /* eliminación para todos sobre el tema original (retenido):
         NO se limpia — los miembros desconectados la recibirán al reconectar */
      this._applyDeleted('g:' + gid, m.id || rest[0]);
      return;
    }
    if (from === Auth.me.uid) return;
    const key = 'g:' + gid;
    if (m.t === 'gtyping') { this.showTyping(key, m.name || from); return; }
    if (m.t === 'msg') {
      if (rest.length !== 1) return;
      const id = rest[0] || m.id;
      if (this.hasMsg(key, id)) return; /* dedup (retenido re-entregado) */

      const res = Spam.check(from, m.text, m.ts || Date.now());
      const msg = {
        t: 'msg', id, from, name: m.name || from, gname: Groups.name(gid), text: String(m.text || ''),
        ts: m.ts || Date.now(), mine: false, spam: res.isSpam, spamReasons: res.reasons, spamScore: res.score
      };
      if (m.re) msg.re = m.re;
      if (m.fwd) msg.fwd = true;
      this.addHist(key, msg);
      this.renderIncoming(key, msg);
      Notify.onIncomingMessage(key, msg, res, from);
      /* ack al autor para su push diferido (y estadística futura) */
      Mqtt.publish(T.evt(from), { t: 'gack', gid, id, from: Auth.me.uid });
      /* RETENCIÓN: en grupos NO se limpia el tema del mensaje — con
         varios miembros, limpiar robaría la copia al que esté offline */
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
      if (this.hasMsg(key, id)) {
        /* ya ensamblado (re-entrega retenida) */
        const k = this.kind(key);
        if (k.type !== 'group') this.clearTopic(this.chunkTopicOf(key, from, id, i));
        return;
      }
      buf = this._chunkBuf[id] = {
        key, from, n: m.n || 0,
        meta: kindT === 'voice'
          ? { name: m.name || from, ts: m.ts || Date.now(), dur: m.dur || 0, mime: m.mime || 'audio/webm', re: m.re }
          : kindT === 'stk'
            ? { name: m.name || from, ts: m.ts || Date.now(), w: m.w, h: m.h, mime: m.mime || 'image/webp', re: m.re }
            : { name: m.name || from, ts: m.ts || Date.now(), w: m.w, h: m.h, re: m.re },
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
          if (meta.re) msg.re = meta.re;
          const k = this.kind(key);
          if (k.type === 'group') msg.gname = Groups.name(k.gid);
          this.addHist(key, msg);
          this.renderIncoming(key, msg);
          Notify.onIncomingMessage(key, msg, res, from);
          /* ack al autor (DM) o gack (grupo): cancela su push diferido */
          if (k.type === 'group') Mqtt.publish(T.evt(from), { t: 'gack', gid: k.gid, id, from: Auth.me.uid });
          else Mqtt.publish(T.evt(from), { t: 'ack', id, from: Auth.me.uid });
          /* limpiar chunks retenidos SOLO en DM (en grupo expiran solos) */
          if (k.type !== 'group') for (let c = 0; c < n; c++) this.clearTopic(this.chunkTopicOf(key, from, id, c));
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

  /* mensaje de sistema del grupo: píldora centrada estilo WhatsApp
     (quién fue añadido, renombrados, expulsados…) */
  if (m.t === 'sys') {
    const ico = m.k === 'renamed' ? 'i-edit' : m.k === 'removed' ? 'i-user-minus' : 'i-user-plus';
    return `<div class="sys-msg" data-mid="${esc(m.id)}"><svg class="icon"><use href="#${ico}"/></svg><span>${esc(m.text)}</span><time>${time}</time></div>`;
  }

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

  /* menú de mensaje (⋮) + reacciones */
  const moreBtn = `<button class="msg-more" data-more="${esc(m.id)}" title="Responder, reaccionar, eliminar…" aria-label="Más opciones"><svg class="icon"><use href="#i-more"/></svg></button>`;
  const rxRow = rxChipsHTML(m);

  /* cita del mensaje respondido */
  const quote = m.re
    ? `<div class="quote" data-reid="${esc(m.re.id)}" style="--sh:${hueOf(m.re.name || '')}" title="Ver mensaje original"><strong>${esc(m.re.name || '')}</strong><span>${esc(truncate(m.re.text || '', 64))}</span></div>`
    : '';
  const fwd = m.fwd ? `<span class="msg-fwd"><svg class="icon"><use href="#i-forward"/></svg>Reenviado</span>` : '';

  /* mensaje eliminado: lápida común para todos los tipos */
  if (m.deleted) {
    return `<div class="msg-row ${mine ? 'mine' : 'theirs'} ${grp}" data-mid="${esc(m.id)}">${inner}
      <div class="bubble deleted">
        <span class="msg-del"><svg class="icon"><use href="#i-trash"/></svg>Se eliminó este mensaje</span>
        ${rxRow}
        <span class="msg-time">${time}</span>
      </div>
    </div>${moreBtn}</div>`;
  }

  /* sticker: grande, sin burbuja (estilo WhatsApp) + ★ para guardarlo en favoritos */
  if (m.t === 'stk') {
    return `<div class="msg-row ${mine ? 'mine' : 'theirs'} ${grp}" data-mid="${esc(m.id)}">${inner}
      <div class="stk-wrap"${spamAttr}>
        ${quote}
        <img class="msg-stk" data-img="${esc(m.id)}" alt="Sticker" loading="lazy">
        ${mine ? '' : `<button class="stk-fav" data-fav="${esc(m.id)}" title="Guardar en mis stickers favoritos"><svg class="icon"><use href="#i-star"/></svg></button>`}
        ${rxRow}
        ${spamChip}
        ${tick}
        <span class="msg-time">${time}</span>
      </div>
    </div>${moreBtn}</div>`;
  }

  if (m.t === 'img') {
    return `<div class="msg-row ${mine ? 'mine' : 'theirs'}" data-mid="${esc(m.id)}">${inner}
      <div class="bubble img ${m.spam ? 'spam' : ''}"${spamAttr}>
        ${quote}${fwd}
        <img class="msg-img" data-img="${esc(m.id)}" alt="Imagen compartida">
        ${rxRow}
        ${spamChip}
        <span class="msg-time">${time}</span>
      </div>
    </div>${moreBtn}</div>`;
  }

  if (m.t === 'voice') {
    return `<div class="msg-row ${mine ? 'mine' : 'theirs'}" data-mid="${esc(m.id)}">${inner}
      <div class="bubble voice ${m.spam ? 'spam' : ''}"${spamAttr}>
        ${quote}${fwd}
        <div class="v-row">
          <button class="v-play" data-vid="${esc(m.id)}" title="Reproducir"><svg class="icon"><use href="#i-play"/></svg></button>
          <span class="v-wave" data-vid="${esc(m.id)}">${'<i></i>'.repeat(26)}</span>
          <span class="v-dur" data-vid="${esc(m.id)}">${Voice.fmtDur(m.dur || 0)}</span>
          <button class="v-speed" data-vid="${esc(m.id)}" title="Velocidad">1x</button>
        </div>
        ${rxRow}
        ${spamChip}
        ${tick}
        <span class="msg-time">${time}</span>
      </div>
    </div>${moreBtn}</div>`;
  }

  return `<div class="msg-row ${mine ? 'mine' : 'theirs'} ${grp}" data-mid="${esc(m.id)}">${inner}
    <div class="bubble ${m.spam ? 'spam' : ''}"${spamAttr}>
      ${quote}${fwd}
      <p class="msg-text">${linkify(esc(m.text))}</p>
      ${rxRow}
      ${spamChip}
      ${tick}
      <span class="msg-time">${time}</span>
    </div>
  </div>${moreBtn}</div>`;
}
