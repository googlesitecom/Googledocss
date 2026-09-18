/* notify.js — sistema de notificaciones
   1) Centro de notificaciones integrado (campana)
   2) Notificaciones del navegador (Notification API) cuando la pestaña está oculta
   3) Sonidos sintetizados y toasts
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

  /* Mensaje entrante (texto o imagen). res = resultado de Spam.check */
  onIncomingMessage(from, m, res) {
    /* ---- PUERTA ANTI-SPAM: cero notificaciones ---- */
    if (res && res.isSpam && Settings.spam) {
      this.spamBlocked++;
      this.save();
      if (App.view === 'settings') App.renderSettings();
      return;
    }

    const viewing = Chat.active === from && !document.hidden;
    if (viewing) return;

    const fromName = m.name || from;
    const preview = m.t === 'img' ? '· Imagen ·' : truncate(m.text, 70);

    Chat.bumpUnread(from);
    this.push({ type: 'msg', from, fromName, text: preview });

    UI.toast(`${fromName}: ${preview}`, { icon: 'chat', onClick: () => App.openChat(from) });
    if (Settings.sound) Sound.msg();

    if (Settings.browser && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      this.browser(`${fromName} te escribió`, preview, { chat: from, name: fromName });
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

  onIncomingCall(meta) {
    if (Settings.browser && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      this.browser(`${meta.name} te está llamando`, meta.video ? 'Videollamada entrante' : 'Llamada de voz entrante', { call: true, name: meta.name });
    }
  },

  onMissedCall({ from, name }) {
    this.push({ type: 'missed', from, fromName: name || 'Desconocido', text: 'Llamada perdida' });
    if (Settings.sound) Sound.msg();
  },

  /* ===================== notificación del navegador ===================== */
  browser(title, body, route = {}) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, {
        body,
        icon: avatarDataURL(route.name || 'N', 96),
        tag: 'nexo-' + (route.chat || route.call ? 'msg' : 'sys'),
        silent: true
      });
      n.onclick = () => {
        window.focus();
        if (route.chat) App.openChat(route.chat);
        else if (route.friends) App.showView('friends');
        try { n.close(); } catch (e) {}
      };
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
      list.innerHTML = `<div class="notif-empty">Sin notificaciones por ahora.<br>Cuando lleguen mensajes, solicitudes o llamadas perdidas, aparecerán aquí.</div>`;
      return;
    }
    const icons = { msg: ['chat', 'msg'], freq: ['user-plus', 'freq'], faccept: ['user-check', 'faccept'], freject: ['user-x', 'freject'], missed: ['phone', 'missed'] };
    list.innerHTML = this.items.map((it) => {
      const [ic, cls] = icons[it.type] || ['chat', 'msg'];
      const route = it.type === 'msg' || it.type === 'missed' ? `data-chat="${esc(it.from)}"` : (it.type === 'freq' ? 'data-friends="1"' : '');
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
