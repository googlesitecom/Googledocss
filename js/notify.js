/* notify.js — sistema de notificaciones
   1) Centro de notificaciones integrado (campana)
   2) Notificaciones del navegador vía Service Worker cuando están
      disponibles (Android incluido), con respaldo en Notification API
   3) Sonidos sintetizados y toasts
   4) Las notificaciones CON LA APP CERRADA las entrega el Service
      Worker (Web Push): las envía el remitente vía push.js cuando
      detecta que el destinatario está desconectado.
   ANTI-SPAM: si un mensaje entrante se clasifica como spam, NO se genera
   ninguna notificación de ningún tipo (solo se entrega marcado en el chat).  */
'use strict';

const Notify = {
  items: [],
  spamBlocked: 0,

  load() {
    if (!Auth.me) return;
    this.items = LS.get(K.notifs(Auth.me.uid), []);
    const st = LS.get(K.spamStats(Auth.me.uid), {});
    this.spamBlocked = st.blocked || 0;
    this.renderBell();
  },
  save() {
    if (!Auth.me) return;
    LS.set(K.notifs(Auth.me.uid), this.items.slice(0, 60));
    LS.set(K.spamStats(Auth.me.uid), { blocked: this.spamBlocked });
  },
  unreadCount() { return this.items.filter((i) => !i.read).length; },

  push(it) {
    it.id = rid();
    it.ts = it.ts || Date.now();
    it.read = false;
    this.items.unshift(it);
    if (this.items.length > 60) this.items.length = 60;
    this.save();
    this.renderBell();
    this.renderPanel();
  },
  markAllRead() {
    this.items.forEach((i) => { i.read = true; });
    this.save();
    this.renderBell();
    this.renderPanel();
  },
  clear() {
    this.items = [];
    this.save();
    this.renderBell();
    this.renderPanel();
  },

  /* ===================== eventos que generan notificaciones ===================== */

  /* Mensaje entrante (texto, imagen o voz). res = resultado de Spam.check.
     chatKey = uid amigo o 'g:<gid>'; en grupos m.gname lleva el nombre. */
  onIncomingMessage(chatKey, m, res, fromUid) {
    /* ---- PUERTA ANTI-SPAM: cero notificaciones ---- */
    if (res && res.isSpam && Settings.spam) {
      this.spamBlocked++;
      this.save();
      if (App.view === 'settings') App.renderSettings();
      return;
    }

    const viewing = Chat.active === chatKey && !document.hidden;
    if (viewing) return;

    const fromName = m.gname ? `${m.name || fromUid || ''} · ${m.gname}` : (m.name || chatKey);
    const preview = m.t === 'img' ? '· Imagen ·' : m.t === 'voice' ? '· Mensaje de voz ·' : truncate(m.text, 70);

    Chat.bumpUnread(chatKey);
    this.push({ type: 'msg', from: chatKey, fromName, text: preview });

    UI.toast(`${fromName}: ${preview}`, { icon: 'chat', onClick: () => App.openChat(chatKey) });
    if (Settings.sound) Sound.msg();

    if (Settings.browser && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      this.browser(`${fromName} te escribió`, preview, { chat: chatKey, name: fromName });
    }
    App.renderConvoList();
    App.updateTitle();
  },

  onFriendRequest({ from, name }) {
    this.push({ type: 'freq', from, fromName: name, text: 'Quiere ser tu amigo' });
    UI.toast(`Nueva solicitud de amistad de ${name}`, { icon: 'user-plus', onClick: () => App.showView('friends') });
    if (Settings.sound) Sound.chime();
    if (Settings.browser && 'Notification' in window && Notification.permission === 'granted') {
      this.browser(`${name} quiere ser tu amigo`, 'Toca para responder la solicitud', { friends: true, name });
    }
  },

  onAccepted({ from, name }) {
    this.push({ type: 'faccept', from, fromName: name, text: 'Aceptó tu solicitud de amistad' });
    UI.toast(`${name} aceptó tu solicitud`, { icon: 'user-check', onClick: () => App.openChat(from) });
    if (Settings.sound) Sound.chime();
  },

  onRejected({ from, name }) {
    this.push({ type: 'freject', from, fromName: name, text: 'No aceptó tu solicitud' });
    UI.toast(`${name} no aceptó tu solicitud`, { icon: 'user-x' });
  },

  onGroupInvite({ gid, from, fromName, name }) {
    this.push({ type: 'ginv', from: 'g:' + gid, fromName: name, text: `${fromName || from} te añadió a este grupo` });
    UI.toast(`Te añadieron al grupo «${name}»`, { icon: 'users', onClick: () => App.openChat('g:' + gid) });
    if (Settings.browser && 'Notification' in window && Notification.permission === 'granted') {
      this.browser(`Nuevo grupo: ${name}`, `${fromName || from} te añadió al grupo`, { chat: 'g:' + gid, name });
    }
  },

  onIncomingCall(meta) {
    if (Settings.browser && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      this.browser(`${meta.name} te está llamando`, meta.video ? 'Videollamada entrante' : 'Llamada de voz entrante', { call: true, name: meta.name });
    }
  },

  onMissedCall({ from, name }) {
    this.push({ type: 'missed', from, fromName: name || 'Desconocido', text: 'Llamada perdida' });
    if (Settings.sound) Sound.msg();
  },

  /* ===================== notificación del navegador (vía SW si existe) ===================== */
  browser(title, body, route = {}) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = {
      body,
      tag: 'nexo-' + (route.chat ? 'msg' : 'sys'),
      silent: true
    };
    const av = Avatars.get(route.chat && !String(route.chat).startsWith('g:') ? route.chat : '');
    opts.icon = (av && av.av) || avatarDataURL(route.name || 'N', 96);
    try {
      if (Push && Push.swReg && Push.swReg.showNotification) {
        /* vía Service Worker: compatible con Android y con la página
           en segundo plano; el clic lo gestiona sw.js */
        Push.swReg.showNotification(title, Object.assign(opts, { data: { route } }));
      } else {
        const n = new Notification(title, opts);
        n.onclick = () => {
          window.focus();
          if (route.chat) App.openChat(route.chat);
          else if (route.friends) App.showView('friends');
          try { n.close(); } catch (e) {}
        };
      }
    } catch (e) { console.warn('Notification', e); }
  },

  /* ===================== UI ===================== */
  renderBell() {
    const dot = $('#bellDot');
    if (!dot) return;
    const n = this.unreadCount();
    dot.hidden = n === 0;
    dot.textContent = n > 9 ? '9+' : String(n);
    if (typeof App !== 'undefined') App.updateTitle();
  },

  renderPanel() {
    const list = $('#notifList');
    if (!list) return;
    if (!this.items.length) {
      list.innerHTML = `<div class="notif-empty">Sin notificaciones por ahora.<br>Cuando lleguen mensajes, grupos o llamadas perdidas, aparecerán aquí.</div>`;
      return;
    }
    const icons = { msg: ['chat', 'msg'], freq: ['user-plus', 'freq'], faccept: ['user-check', 'faccept'], freject: ['user-x', 'freject'], missed: ['phone', 'missed'], ginv: ['users', 'ginv'] };
    list.innerHTML = this.items.map((it) => {
      const [ic, cls] = icons[it.type] || ['chat', 'msg'];
      const route = it.type === 'msg' || it.type === 'missed' || it.type === 'ginv' ? `data-chat="${esc(it.from)}"` : (it.type === 'freq' ? 'data-friends="1"' : '');
      return `<button class="notif-item" ${route}>
        <span class="n-ic ${cls}"><svg class="icon"><use href="#i-${ic}"/></svg></span>
        <span class="n-body"><strong>${esc(it.fromName || 'Nexo')}</strong><p>${esc(it.text)}</p></span>
        <span class="n-time">${fmtDay(it.ts)}</span>
      </button>`;
    }).join('');
  },

  togglePanel(force) {
    const p = $('#notifPanel');
    const show = force != null ? force : p.hidden;
    p.hidden = !show;
    if (show) {
      this.renderPanel();
      this.markAllRead();
    }
  }
};
