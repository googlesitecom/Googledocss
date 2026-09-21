/* app.js — orquestador: arranque, vistas, ajustes, enrutado de mensajes */
'use strict';

/* Preferencias globales (persistidas) */
const Settings = Object.assign(
  { sound: true, browser: true, spam: true, sens: 'medio', theme: null, accentH: null, wp: 'none' },
  LS.get(K.prefs, {})
);
function saveSettings() { LS.set(K.prefs, Settings); }

const App = {
  view: 'chats',

  /* ================== tema ================== */
  initTheme() {
    let t = Settings.theme;
    if (!t) t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    this._themeIcon();
    if (window.Theme) Theme.apply();
  },
  toggleTheme() {
    const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = cur;
    Settings.theme = cur;
    saveSettings();
    this._themeIcon();
    if (window.Theme) Theme.apply();
  },
  _themeIcon() {
    const use = $('#themeToggle use');
    if (use) use.setAttribute('href', document.documentElement.dataset.theme === 'light' ? '#i-moon' : '#i-sun');
  },

  /* ================== pantallas ================== */
  showAuth() {
    $('#authScreen').hidden = false;
    $('#appScreen').hidden = true;
  },
  showApp() {
    $('#authScreen').hidden = true;
    $('#appScreen').hidden = false;
    this.showView('chats');
    this.renderAll();
    this.updateTitle();
    this.maybeShowBanner();
    this.handleHashRoute();
  },
  renderAll() {
    this.renderMyAvatar();
    this.renderConvoList();
    this.renderFriends();
    this.renderSettings();
    Notify.renderBell();
    Chat.renderPresence();
  },
  renderMyAvatar() {
    const av = $('#myAvatar');
    if (!av || !Auth.me) return;
    av.innerHTML = Avatars.html(Auth.me.uid, Auth.me.name);
    avatarStyle(av, Auth.me.uid);
    av.title = `${Auth.me.name} · @${Auth.me.uid}`;
  },

  showView(v) {
    this.view = v;
    ['chats', 'friends', 'settings'].forEach((x) => {
      const el = $('#view' + x.charAt(0).toUpperCase() + x.slice(1));
      if (el) el.hidden = x !== v;
    });
    $$('.rail-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $('#panelTitle').textContent = { chats: 'Chats', friends: 'Amigos', settings: 'Ajustes' }[v] || v;
    $('#notifPanel').hidden = true;
    if (v === 'chats') this.renderConvoList();
    if (v === 'friends') this.renderFriends();
    if (v === 'settings') this.renderSettings();
    if (window.innerWidth <= 920) this.setChatOpen(false);
  },
  openChat(key) {
    this.showView('chats');
    Chat.open(key);
  },
  setChatOpen(on) { document.body.classList.toggle('chat-open', on); },

  /* ================== estado de conexión ================== */
  setConn(s) {
    const el = $('#connStatus');
    if (!el) return;
    el.classList.toggle('online', s === 'online');
    el.classList.toggle('offline', s === 'offline');
    el.querySelector('.conn-txt').textContent =
      s === 'online' ? 'Conectado · en línea' : s === 'offline' ? 'Sin conexión' : 'Conectando…';
  },
  setAuthConn(s) {
    const el = $('#authConn');
    if (!el) return;
    el.classList.toggle('online', s === 'online');
    el.classList.toggle('offline', s === 'offline');
    el.lastElementChild.textContent =
      s === 'online' ? 'Conectado a la red' : s === 'offline' ? 'Sin conexión (reintentando…)' : 'Conectando con la red…';
  },

  /* ================== listas ================== */
  renderConvoList() {
    if (!Auth.me) return;
    const list = $('#convoList');
    if (!list) return;

    /* DM de amigos + grupos, ordenados por última actividad */
    const items = [
      ...Friends.all().map((f) => ({ key: f.uid, group: null })),
      ...Groups.all().map((g) => ({ key: 'g:' + g.id, group: g }))
    ].sort((a, b) => Chat.lastActivity(b.key) - Chat.lastActivity(a.key));

    if (!items.length) {
      list.innerHTML = `<div class="f-empty">Sin conversaciones todavía.<br>Añade amigos desde la pestaña <strong>Amigos</strong> o crea un <strong>grupo</strong>.</div>`;
      return;
    }
    list.innerHTML = items.map(({ key, group }) => {
      const last = Chat.lastMsg(key);
      const name = group ? group.name : Friends.name(key);
      let prev = group ? `${group.members.length} miembros` : 'Inicia la conversación';
      if (last) prev = (last.mine ? 'Tú: ' : (group ? (last.name || '') + ': ' : '')) +
        (last.t === 'img' ? '· Imagen ·' : last.t === 'voice' ? '· Mensaje de voz ·' : truncate(last.text, group ? 34 : 42));
      const un = Chat.unread(key);
      const active = Chat.active === key && this.view === 'chats';
      const avInner = group
        ? `<span class="g-mark"><svg class="icon"><use href="#i-users"/></svg></span>`
        : Avatars.html(key, name);
      const dot = group
        ? `<span class="pres-dot ${Groups.onlineCount(group.id) ? 'on' : ''}" title="grupo"></span>`
        : `<span class="pres-dot ${Presence.isOnline(key) ? 'on' : ''}" title="${Presence.status(key)}"></span>`;
      return `<button class="convo ${active ? 'active' : ''} ${group ? 'is-group' : ''}" data-key="${esc(key)}">
        <div class="avatar" style="--h:${hueOf(group ? group.id : key)}">${avInner}</div>
        <div class="convo-main">
          <div class="convo-top"><strong>${esc(name)}</strong><span class="convo-time">${last ? fmtDay(last.ts) : ''}</span></div>
          <div class="convo-bot"><span class="convo-prev">${esc(prev)}</span>${un ? `<span class="unread">${un > 99 ? '99+' : un}</span>` : ''}</div>
        </div>
        ${dot}
      </button>`;
    }).join('');
  },

  renderFriends() {
    if (!Auth.me) return;
    const box = $('#friendsSections');
    if (!box) return;
    const inArr = [...Friends._pendingIn.entries()];
    const outArr = Friends.pendingOut();
    const all = Friends.all();
    let html = '';

    html += `<div class="f-section"><h4>Solicitudes recibidas ${inArr.length ? `<span class="n-badge">${inArr.length}</span>` : ''}</h4>`;
    html += inArr.length ? inArr.map(([uid, p]) => `
      <div class="f-row">
        <div class="avatar" style="--h:${hueOf(uid)}">${Avatars.html(uid, p.name)}</div>
        <div class="f-info"><strong>${esc(p.name)}</strong><span>@${esc(uid)}</span></div>
        <div class="f-acts">
          <button class="f-btn accept" data-act="accept" data-uid="${esc(uid)}"><svg class="icon"><use href="#i-check"/></svg>Aceptar</button>
          <button class="f-btn reject" data-act="reject" data-uid="${esc(uid)}">Rechazar</button>
        </div>
      </div>`).join('')
      : `<div class="f-empty">No tienes solicitudes pendientes.</div>`;
    html += `</div>`;

    if (outArr.length) {
      html += `<div class="f-section"><h4>Enviadas</h4>` + outArr.map((p) => `
        <div class="f-row">
          <div class="avatar" style="--h:${hueOf(p.uid)}">${Avatars.html(p.uid, p.name)}</div>
          <div class="f-info"><strong>${esc(p.name)}</strong><span>@${esc(p.uid)} · esperando</span></div>
          <div class="f-acts"><button class="f-btn reject" data-act="cancel" data-uid="${esc(p.uid)}">Cancelar</button></div>
        </div>`).join('') + `</div>`;
    }

    html += `<div class="f-section"><h4>Mis amigos <span class="n-badge">${all.length}</span></h4>`;
    html += all.length ? all.map((f) => `
      <div class="f-row">
        <div class="avatar" style="--h:${hueOf(f.uid)}">${Avatars.html(f.uid, f.name)}</div>
        <div class="f-info"><strong>${esc(f.name)}</strong><span>@${esc(f.uid)}</span></div>
        <span class="pres-dot ${Presence.isOnline(f.uid) ? 'on' : ''}" title="${Presence.status(f.uid)}"></span>
        <div class="f-acts">
          <button class="f-btn chat" data-act="chat" data-uid="${esc(f.uid)}"><svg class="icon"><use href="#i-chat"/></svg>Chatear</button>
          <button class="f-btn chat" data-act="call" data-uid="${esc(f.uid)}" title="Llamar"><svg class="icon"><use href="#i-phone"/></svg></button>
          <button class="f-btn reject" data-act="remove" data-uid="${esc(f.uid)}" title="Eliminar amigo"><svg class="icon"><use href="#i-user-minus"/></svg></button>
        </div>
      </div>`).join('')
      : `<div class="f-empty">Aún no tienes amigos.<br>Busca por su nombre de usuario exacto y envíales una solicitud: tendrán que aceptarla para chatear.</div>`;
    html += `</div>`;

    box.innerHTML = html;
  },

  /* ================== ajustes ================== */
  renderSettings() {
    if (!Auth.me) return;
    const box = $('#viewSettings');
    if (!box) return;
    const perm = Push.permission();
    const pushOn = Push.isOn();
    const accentH = Settings.accentH != null ? Settings.accentH : Theme.DEFAULT_H;

    box.innerHTML = `
      <div class="set-card">
        <h3><svg class="icon"><use href="#i-users"/></svg>Perfil</h3>
        <p class="desc">Así te ven tus amigos. Tu cuenta es @${esc(Auth.me.uid)}.</p>
        <div class="profile-row">
          <div class="avatar big" style="--h:${hueOf(Auth.me.uid)}">${Avatars.html(Auth.me.uid, Auth.me.name)}</div>
          <div class="profile-main">
            <input id="setName" class="set-input" maxlength="32" value="${esc(Auth.me.name)}">
            <div class="profile-btns">
              <button id="btnAvatar" class="f-btn chat"><svg class="icon"><use href="#i-camera"/></svg>Cambiar foto</button>
              ${Auth.me.av ? '<button id="btnNoAvatar" class="f-btn reject">Quitar foto</button>' : ''}
            </div>
          </div>
        </div>
        <button id="btnSaveName" class="f-btn add" style="width:100%;justify-content:center;margin-top:10px">Guardar nombre</button>
      </div>

      <div class="set-card">
        <h3><svg class="icon"><use href="#i-bell"/></svg>Notificaciones</h3>
        <p class="desc">Avisos de mensajes, grupos, solicitudes y llamadas perdidas.</p>
        <div class="set-row">
          <div class="lbl"><strong>Sonidos</strong><span>Alertas audibles dentro de la app</span></div>
          <label class="sw"><input type="checkbox" data-set="sound" ${Settings.sound ? 'checked' : ''}><i></i></label>
        </div>
        <div class="set-row">
          <div class="lbl"><strong>Notificaciones del navegador</strong><span>Cuando la pestaña está en segundo plano</span></div>
          <label class="sw"><input type="checkbox" data-set="browser" ${Settings.browser ? 'checked' : ''}><i></i></label>
        </div>
        <div class="set-row">
          <div class="lbl"><strong>Notificaciones sin abrir la app</strong><span>Llegan aunque cierres Nexo (Web Push)</span></div>
          ${pushOn
            ? '<span class="push-ok"><svg class="icon"><use href="#i-check"/></svg>Activas</span>'
            : perm === 'denied'
              ? '<span class="push-deny">Bloqueado</span>'
              : `<button id="btnPush" class="f-btn add">Activar</button>`}
        </div>
        ${pushOn ? `<p class="desc" style="margin:8px 0 0;color:var(--green)">Funciona con la app cerrada. En iPhone/iPad, instala Nexo en la pantalla de inicio para recibirlas.</p>` : ''}
        ${perm === 'default' && !pushOn ? `<button id="btnPerm" class="f-btn add" style="width:100%;justify-content:center;margin-top:10px">Activar notificaciones del navegador</button>` : ''}
        ${perm === 'denied' ? `<p class="desc" style="margin:10px 0 0;color:var(--red)">Permiso bloqueado: actívalo en los ajustes del sitio de tu navegador.</p>` : ''}
        <button id="btnTestNotif" class="f-btn chat" style="width:100%;justify-content:center;margin-top:10px">Probar notificación</button>
      </div>

      <div class="set-card">
        <h3><svg class="icon"><use href="#i-palette"/></svg>Apariencia</h3>
        <p class="desc">Personaliza el color de Nexo y el fondo de tus chats.</p>
        <div class="lbl" style="margin-bottom:8px"><strong>Color de acento</strong></div>
        <div class="acc-row">
          ${Theme.PRESETS.map((p) => `<button class="acc-dot ${accentH === p.h ? 'sel' : ''}" data-acc="${p.h}" style="--ah:${p.h}" title="${p.name}"></button>`).join('')}
          <label class="acc-custom" title="Color personalizado">
            <input type="range" id="accHue" min="0" max="359" value="${accentH}">
          </label>
          <button class="acc-reset" id="btnAccReset" title="Volver al teal original">↺</button>
        </div>
        <div class="lbl" style="margin:14px 0 8px"><strong>Fondo del chat</strong></div>
        <div class="wp-row">
          ${Theme.WALLPAPERS.map((w) => `<button class="wp-tile ${Settings.wp === w.id ? 'sel' : ''} wp-${w.id}" data-wp="${w.id}" title="${w.name}"></button>`).join('')}
          <button class="wp-tile custom ${Settings.wp === 'custom' ? 'sel' : ''}" data-wp="custom" title="Imagen propia">
            <svg class="icon"><use href="#i-image"/></svg>
          </button>
        </div>
        ${Settings.wp === 'custom' ? `<button id="btnWpClear" class="f-btn reject" style="margin-top:10px">Quitar imagen de fondo</button>` : ''}
      </div>

      <div class="set-card">
        <h3><svg class="icon"><use href="#i-shield"/></svg>Filtro anti-spam</h3>
        <p class="desc">Los mensajes detectados como spam se entregan marcados en el chat, pero <strong>no generan notificaciones</strong>: ni sonido, ni aviso, ni badge, ni push.</p>
        <div class="set-row">
          <div class="lbl"><strong>Activar filtro</strong><span>Suprimir notificaciones de spam</span></div>
          <label class="sw"><input type="checkbox" data-set="spam" ${Settings.spam ? 'checked' : ''}><i></i></label>
        </div>
        <div class="set-row">
          <div class="lbl"><strong>Sensibilidad</strong><span>Umbral de detección</span></div>
          <select class="seg" data-set="sens">
            <option value="bajo" ${Settings.sens === 'bajo' ? 'selected' : ''}>Baja</option>
            <option value="medio" ${Settings.sens === 'medio' ? 'selected' : ''}>Media</option>
            <option value="alto" ${Settings.sens === 'alto' ? 'selected' : ''}>Alta</option>
          </select>
        </div>
        <div class="set-row">
          <div class="lbl"><strong>Spam bloqueado</strong><span>Notificaciones suprimidas por el filtro</span></div>
          <span class="spam-count"><svg class="icon"><use href="#i-shield"/></svg>${Notify.spamBlocked}</span>
        </div>
      </div>

      <div class="set-card">
        <h3><svg class="icon"><use href="#i-logout"/></svg>Sesión</h3>
        <p class="desc">Conectado como <strong>${esc(Auth.me.name)}</strong> · @${esc(Auth.me.uid)}</p>
        <button id="btnLogout" class="f-btn reject" style="width:100%;justify-content:center"><svg class="icon"><use href="#i-logout"/></svg>Cerrar sesión</button>
      </div>`;
  },

  /* ================== presencia / título ================== */
  refreshPresenceUI() {
    this.renderConvoList();
    Chat.renderPresence();
  },
  updateTitle() {
    if (!Auth.me) return;
    const u = LS.get(K.unread(Auth.me.uid), {});
    const total = Object.values(u).reduce((a, b) => a + b, 0);
    document.title = (total ? `(${total}) ` : '') + 'Nexo · Chat';
  },

  /* ================== enrutado MQTT → módulos ================== */
  routeMessage(topic, payloadStr) {
    const p = topic.split('/');
    if (p[0] !== 'nexo' || p[1] !== 'v1') return;
    let m = null;
    try { m = JSON.parse(payloadStr); } catch (e) { return; }
    const kind = p[2];
    if (kind === 'dm' && p[3] === Auth.me.uid) Chat.handleIncoming(p[4], p.slice(5), m);
    else if (kind === 'gm') Chat.handleGroupIncoming(p[3], p[4], p.slice(5), m);
    else if (kind === 'ginv' && p[3] === Auth.me.uid) Groups.onInvite(p[4], m);
    else if (kind === 'freq' && p[3] === Auth.me.uid) Friends.handleRequest(p[4], m);
    else if (kind === 'fresp' && p[3] === Auth.me.uid) Friends.handleResponse(p[4], m);
    else if (kind === 'evt' && p[3] === Auth.me.uid) this.handleEvt(m);
    else if (kind === 'presence') Presence.update(p[3], m);
    else if (kind === 'profile') Friends.onProfile(p[3], m);
  },
  handleEvt(m) {
    if (!m || !m.t) return;
    if (m.t === 'ack') Chat.markAcked(m.id);
    else if (m.t === 'typing') Chat.showTyping(m.from, m.name || m.from);
    else if (m.t === 'unfriend') Friends.onUnfriend(m.from);
    else if (m.t === 'gleft') Groups.onMemberLeft(m);
    else if (m.t === 'ginvite') Groups.onInvite(m.gid, { gid: m.gid, name: m.name, from: m.from, fromName: m.fromName });
  },

  /* ================== lightbox ================== */
  openLightbox(src) {
    $('#lightboxImg').src = src;
    $('#lightbox').hidden = false;
  },

  /* ================== banner de notificaciones (permiso con gesto) ================== */
  maybeShowBanner() {
    const b = $('#notifBanner');
    if (!b) return;
    const perm = Push.permission();
    b.hidden = !(perm === 'default' && Settings.browser);
  },
  hideBanner() { const b = $('#notifBanner'); if (b) b.hidden = true; },

  /* ================== ruta desde notificación (SW o URL) ================== */
  handleRoute(route) {
    if (!route) return;
    if (route.chat) App.openChat(route.chat);
    else if (route.friends) App.showView('friends');
  },
  handleHashRoute() {
    const m = location.hash.match(/^#c=(.+)$/);
    if (m) {
      try { this.handleRoute({ chat: decodeURIComponent(m[1]) }); } catch (e) {}
      history.replaceState(null, '', location.pathname + location.search);
    }
  },

  /* ================== wiring ================== */
  wireAuthUI() {
    $$('.auth-tab').forEach((b) => b.addEventListener('click', () => {
      $$('.auth-tab').forEach((x) => x.classList.toggle('active', x === b));
      $('#loginForm').hidden = b.dataset.tab !== 'login';
      $('#registerForm').hidden = b.dataset.tab !== 'register';
    }));

    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#loginErr');
      err.hidden = true;
      if (!Mqtt.connected) { err.textContent = 'Conectando con la red… espera un instante y reintenta.'; err.hidden = false; return; }
      const btn = $('#loginBtn');
      btn.disabled = true;
      btn.textContent = 'Verificando…';
      try {
        await Auth.login($('#liUser').value, $('#liPass').value);
        Auth.startAppConnection();
        App.showApp();
      } catch (ex) {
        err.textContent = ex.message || 'No se pudo iniciar sesión.';
        err.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Entrar';
      }
    });

    $('#registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#regErr');
      err.hidden = true;
      if ($('#riPass').value !== $('#riPass2').value) {
        err.textContent = 'Las contraseñas no coinciden.'; err.hidden = false; return;
      }
      if (!Mqtt.connected) { err.textContent = 'Conectando con la red… espera un instante y reintenta.'; err.hidden = false; return; }
      const btn = $('#regBtn');
      btn.disabled = true;
      btn.textContent = 'Creando…';
      try {
        await Auth.register($('#riUser').value, $('#riName').value, $('#riPass').value);
        Auth.startAppConnection();
        App.showApp();
        UI.toast('¡Cuenta creada! Bienvenido a Nexo.');
      } catch (ex) {
        err.textContent = ex.message || 'No se pudo crear la cuenta.';
        err.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Crear cuenta';
      }
    });
  },

  wireAppUI() {
    /* navegación */
    $$('.rail-btn[data-view]').forEach((b) => b.addEventListener('click', () => App.showView(b.dataset.view)));
    $('#themeToggle').addEventListener('click', () => App.toggleTheme());

    /* campana de notificaciones */
    $('#btnBell').addEventListener('click', (e) => { e.stopPropagation(); Notify.togglePanel(); });
    $('#notifClear').addEventListener('click', () => Notify.clear());
    $('#notifList').addEventListener('click', (e) => {
      const b = e.target.closest('.notif-item');
      if (!b) return;
      $('#notifPanel').hidden = true;
      if (b.dataset.chat) App.openChat(b.dataset.chat);
      else if (b.dataset.friends) App.showView('friends');
    });
    document.addEventListener('click', (e) => {
      const p = $('#notifPanel');
      if (p && !p.hidden && !p.contains(e.target) && !e.target.closest('#btnBell')) p.hidden = true;
    });

    /* banner de activación de notificaciones (gesto del usuario) */
    $('#notifBanner') && $('#notifBanner').addEventListener('click', async (e) => {
      if (e.target.closest('#btnBannerNo')) { App.hideBanner(); return; }
      if (e.target.closest('#btnBannerYes')) {
        try {
          await Push.enable();
          App.hideBanner();
          App.renderSettings();
          UI.toast('Notificaciones activadas: te avisaremos aunque cierres la app.');
          Notify.browser('Notificaciones activadas', 'Así te avisaremos de tus mensajes.', { friends: true, name: Auth.me.name });
        } catch (ex) {
          UI.toast(ex.message || 'No se pudo activar.');
          App.renderSettings();
        }
      }
    });

    /* lista de conversaciones (DM + grupos) */
    $('#convoList').addEventListener('click', (e) => {
      const b = e.target.closest('.convo');
      if (b) App.openChat(b.dataset.key);
    });

    /* crear grupo */
    $('#btnNewGroup').addEventListener('click', () => Groups.openCreateModal());

    /* cabecera de grupo → miembros */
    $('#chatPeer').addEventListener('click', () => {
      const k = Chat.kind(Chat.active);
      if (k.type === 'group' && k.gid) Groups.openMembersModal(k.gid);
    });
    $('#btnLeaveGroup').addEventListener('click', () => {
      const k = Chat.kind(Chat.active);
      if (k.type !== 'group' || !k.gid) return;
      const g = Groups.get(k.gid);
      UI.confirm('Salir del grupo', `¿Seguro que quieres salir de «${g ? g.name : ''}»?`, 'Salir', true)
        .then((ok) => { if (ok) Groups.leave(k.gid); });
    });

    /* amigos: búsqueda y acciones */
    $('#btnSearch').addEventListener('click', () => App.doSearch());
    $('#friendSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') App.doSearch(); });
    $('#viewFriends').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const uid = b.dataset.uid;
      if (act === 'add') Friends.sendRequest({ uid, name: b.dataset.name || uid });
      else if (act === 'accept') Friends.accept(uid);
      else if (act === 'reject') Friends.reject(uid);
      else if (act === 'cancel') {
        Mqtt.publish(T.freq(uid, Auth.me.uid), '', { retain: true });
        Friends.saveOut(Friends.pendingOut().filter((p) => p.uid !== uid));
        App.renderFriends();
      }
      else if (act === 'chat') App.openChat(uid);
      else if (act === 'call') Calls.start(uid, false);
      else if (act === 'remove') {
        UI.confirm('Eliminar amigo', `¿Eliminar a ${Friends.name(uid)}? Dejaréis de ser amigos.`, 'Eliminar', true)
          .then((ok) => { if (ok) Friends.removeFriend(uid); });
      }
    });

    /* chat */
    $('#btnBack').addEventListener('click', () => Chat.close());
    $('#btnSend').addEventListener('click', () => Chat.sendText());
    const inp = $('#msgInput');
    inp.addEventListener('input', () => {
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 132) + 'px';
      Chat.typingThrottle();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Chat.sendText(); }
    });
    $('#btnAttach').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) Chat.sendImage(f);
      e.target.value = '';
    });

    /* mensajes de voz: grabar */
    $('#btnMic').addEventListener('click', () => Voice.start());
    $('#recCancel').addEventListener('click', () => Voice.cancel());
    $('#recSend').addEventListener('click', () => Voice.stop(true));

    /* reproductor de voz (delegación) */
    $('#messages').addEventListener('click', (e) => {
      const img = e.target.closest('.msg-img');
      if (img && img.src) { App.openLightbox(img.src); return; }
      const play = e.target.closest('.v-play');
      if (play) { Chat.toggleVoice(play.dataset.vid, play); return; }
      const spd = e.target.closest('.v-speed');
      if (spd) Chat.cycleVoiceSpeed(spd.dataset.vid, spd);
    });

    /* llamadas */
    $('#btnCallAudio').addEventListener('click', () => Chat.active && Calls.start(Chat.active, false));
    $('#btnCallVideo').addEventListener('click', () => Chat.active && Calls.start(Chat.active, true));
    $('#callControls').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'accept') Calls.accept();
      else if (act === 'decline') Calls.decline();
      else if (act === 'hangup') Calls.hangup();
      else if (act === 'mic') Calls.toggleMic();
      else if (act === 'cam') Calls.toggleCam();
    });
    $('#btnRemoveFriend').addEventListener('click', () => {
      if (!Chat.active) return;
      const uid = Chat.active;
      UI.confirm('Eliminar amigo', `¿Eliminar a ${Friends.name(uid)}? Dejaréis de ser amigos.`, 'Eliminar', true)
        .then((ok) => { if (ok) Friends.removeFriend(uid); });
    });

    /* ajustes (delegación) */
    $('#viewSettings').addEventListener('change', (e) => {
      const el = e.target.closest('[data-set]');
      if (!el) return;
      const k = el.dataset.set;
      if (el.type === 'checkbox') Settings[k] = el.checked;
      else Settings[k] = el.value;
      saveSettings();
      if (k === 'sens') UI.toast(`Sensibilidad anti-spam: ${({ bajo: 'baja', medio: 'media', alto: 'alta' })[Settings.sens]}`);
      if (el.id === 'accHue') {
        Settings.accentH = parseInt(el.value, 10) || 0;
        saveSettings();
        Theme.apply();
      }
    });
    $('#viewSettings').addEventListener('input', (e) => {
      if (e.target.id === 'accHue') {
        Settings.accentH = parseInt(e.target.value, 10) || 0;
        saveSettings();
        Theme.apply();
      }
    });
    $('#viewSettings').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      const acc = e.target.closest('[data-acc]');
      const wp = e.target.closest('[data-wp]');
      if (acc) { Theme.setAccent(parseInt(acc.dataset.acc, 10)); App.renderSettings(); return; }
      if (wp) {
        if (wp.dataset.wp === 'custom') { $('#wpInput').click(); return; }
        Theme.setWallpaper(wp.dataset.wp);
        App.renderSettings();
        return;
      }
      if (!btn) return;
      if (btn.id === 'btnSaveName') {
        try {
          await Auth.updateName($('#setName').value);
          UI.toast('Nombre actualizado.');
          App.renderAll();
        } catch (ex) { UI.toast(ex.message); }
      } else if (btn.id === 'btnAvatar') {
        $('#avatarInput').click();
      } else if (btn.id === 'btnNoAvatar') {
        await Auth.removeAvatar();
      } else if (btn.id === 'btnWpClear') {
        await Theme.clearCustomWallpaper();
        App.renderSettings();
      } else if (btn.id === 'btnPush' || btn.id === 'btnPerm') {
        try {
          await Push.enable();
          App.renderSettings();
          UI.toast('Notificaciones activadas: te avisaremos aunque cierres la app.');
        } catch (ex) {
          UI.toast(ex.message || 'No se pudo activar.');
          App.renderSettings();
        }
      } else if (btn.id === 'btnTestNotif') {
        if ('Notification' in window && Notification.permission === 'granted') {
          Notify.browser('Notificación de prueba de Nexo', 'Así se verán tus avisos de mensajes.', { name: Auth.me.name });
        }
        UI.toast('Notificación de prueba enviada');
        if (Settings.sound) Sound.msg();
      } else if (btn.id === 'btnAccReset') {
        Theme.resetAccent();
        App.renderSettings();
      } else if (btn.id === 'btnLogout') {
        Auth.logout();
      }
    });
    $('#avatarInput').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try { await Auth.setAvatar(f); } catch (ex) { UI.toast(ex.message || 'No se pudo cambiar la foto.'); }
    });
    $('#wpInput').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      await Theme.setCustomWallpaper(f);
      App.renderSettings();
    });

    /* lightbox */
    $('#lightbox').addEventListener('click', (e) => {
      if (e.target.id === 'lightbox' || e.target.closest('#lightboxClose')) $('#lightbox').hidden = true;
    });

    /* rutas enviadas por el Service Worker (clic en notificación) */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        const d = e.data || {};
        if (d.nexoRoute) App.handleRoute(d.nexoRoute);
        if (d.nexoPushSubChanged && Push.sub) Push.publishSub();
      });
    }

    /* al volver a la pestaña: limpiar no leídos del chat activo */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Auth.me && Chat.active) Chat.clearUnread(Chat.active);
    });
  },

  async doSearch() {
    const box = $('#searchResult');
    const q = $('#friendSearch').value;
    box.innerHTML = `<div class="f-empty">Buscando…</div>`;
    const r = await Friends.search(q);
    if (r.err) { box.innerHTML = `<div class="f-empty">${esc(r.err)}</div>`; return; }
    const p = r.prof;
    const isF = Friends.isFriend(p.uid);
    const incoming = Friends._pendingIn.has(p.uid);
    const pending = Friends.pendingOut().some((x) => x.uid === p.uid);
    let action;
    if (isF) action = `<button class="f-btn ok" disabled>Ya son amigos</button>`;
    else if (incoming) action = `<button class="f-btn accept" data-act="accept" data-uid="${esc(p.uid)}">Aceptar solicitud</button>`;
    else if (pending) action = `<button class="f-btn ok" disabled>Solicitud enviada</button>`;
    else action = `<button class="f-btn add" data-act="add" data-uid="${esc(p.uid)}" data-name="${esc(p.name || p.uid)}"><svg class="icon"><use href="#i-user-plus"/></svg>Añadir</button>`;
    box.innerHTML = `<div class="f-card">
      <div class="avatar" style="--h:${hueOf(p.uid)}">${p.av ? `<img src="${esc(p.av)}" alt="">` : esc(initials(p.name || p.uid))}</div>
      <div class="f-info"><strong>${esc(p.name || p.uid)}</strong><span>@${esc(p.uid)}</span></div>
      ${action}
    </div>`;
  }
};

/* ================== arranque ================== */
window.addEventListener('DOMContentLoaded', async () => {
  App.initTheme();
  App.wireAuthUI();
  App.wireAppUI();

  try { await IDB.open(); } catch (e) { console.warn('IndexedDB no disponible', e); }

  if (Auth.resume()) {
    /* sesión guardada: entrar directo (la conexión se establece en paralelo) */
    App.showApp();
    Auth.startAppConnection();
  } else {
    App.showAuth();
    Auth.startAnonConnection();
  }
});
