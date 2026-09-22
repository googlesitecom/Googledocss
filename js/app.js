/* app.js — orquestador: arranque, vistas, ajustes, enrutado de mensajes */
'use strict';

/* Preferencias globales (persistidas) */
const Settings = Object.assign(
  { sound: true, browser: true, spam: true, sens: 'medio', theme: null, accentH: null, wp: 'none',
    volume: 0.8, vibrate: true, muted: {}, pinned: {}, focus: false },
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
    if (typeof Theme !== 'undefined') Theme.apply();
  },
  toggleTheme() {
    const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = cur;
    Settings.theme = cur;
    saveSettings();
    this._themeIcon();
    if (typeof Theme !== 'undefined') Theme.apply();
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
    this.setFocus(Settings.focus);
    Chat.syncMuted(); /* lista de silenciados para el Service Worker */
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
    ['chats', 'friends', 'games', 'settings'].forEach((x) => {
      const el = $('#view' + x.charAt(0).toUpperCase() + x.slice(1));
      if (el) el.hidden = x !== v;
    });
    $$('.rail-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $('#panelTitle').textContent = { chats: 'Chats', friends: 'Amigos', games: 'Juegos', settings: 'Ajustes' }[v] || v;
    $('#notifPanel').hidden = true;
    if (v === 'chats') this.renderConvoList();
    if (v === 'friends') this.renderFriends();
    if (v === 'games' && typeof Games !== 'undefined') Games.render();
    if (v === 'settings') this.renderSettings();
    if (window.innerWidth <= 920) this.setChatOpen(false);
  },
  openChat(key) {
    this.showView('chats');
    if (typeof Games !== 'undefined' && Games.close) Games.close();
    Chat.open(key);
  },
  setChatOpen(on) { document.body.classList.toggle('chat-open', on); },

  /* ================== MODO ENFOQUE: ocultar la barra lateral ==================
     Solo queda el chat (o el juego) a pantalla completa. Se restaura con
     el botón flotante que aparece arriba a la izquierda.                    */
  setFocus(on) {
    Settings.focus = !!on;
    saveSettings();
    document.body.classList.toggle('focus', !!on);
    const btn = $('#focusRestore');
    if (btn) btn.hidden = !on;
  },

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

    /* DM de amigos + grupos: FIJADOS arriba y luego por última actividad */
    const items = [
      ...Friends.all().map((f) => ({ key: f.uid, group: null })),
      ...Groups.all().map((g) => ({ key: 'g:' + g.id, group: g }))
    ].sort((a, b) => {
      const pa = Chat.isPinned(a.key) ? 1 : 0;
      const pb = Chat.isPinned(b.key) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return Chat.lastActivity(b.key) - Chat.lastActivity(a.key);
    });

    if (!items.length) {
      list.innerHTML = `<div class="f-empty">Sin conversaciones todavía.<br>Añade amigos desde la pestaña <strong>Amigos</strong> o crea un <strong>grupo</strong>.</div>`;
      return;
    }
    list.innerHTML = items.map(({ key, group }) => {
      const last = Chat.lastMsg(key);
      const name = group ? group.name : Friends.name(key);
      const pinned = Chat.isPinned(key);
      const muted = Chat.isMuted(key);
      /* ¿hay una llamada de grupo EN CURSO en la que no estoy? */
      const og = (group && typeof Calls !== 'undefined' && Calls.ongoingInfo)
        ? Calls.ongoingInfo(group.id) : null;
      const inThis = (group && typeof Calls !== 'undefined' && Calls.inThisCall)
        ? Calls.inThisCall(group.id) : false;
      let prev = group ? `${group.members.length} miembros` : 'Inicia la conversación';
      if (og && !inThis) prev = 'Llamada en curso · toca para unirte';
      else if (inThis) prev = 'Estás en la llamada';
      else if (last) prev = (last.mine ? 'Tú: ' : (group ? (last.name || '') + ': ' : '')) +
        (last.deleted ? '· Mensaje eliminado ·' : last.t === 'img' ? '· Imagen ·' : last.t === 'voice' ? '· Mensaje de voz ·' : last.t === 'stk' ? '· Sticker ·' : truncate(last.text, group ? 34 : 42));
      const un = Chat.unread(key);
      const active = Chat.active === key && this.view === 'chats';
      const avInner = group
        ? GroupAvatars.html(group.id)
        : Avatars.html(key, name);
      const dot = group
        ? `<span class="pres-dot ${Groups.onlineCount(group.id) ? 'on' : ''}" title="grupo"></span>`
        : `<span class="pres-dot ${Presence.isOnline(key) ? 'on' : ''}" title="${Presence.status(key)}"></span>`;
      const tags = `${pinned ? `<span class="convo-tag pin" title="Chat fijado"><svg class="icon"><use href="#i-pin"/></svg></span>` : ''}${muted ? `<span class="convo-tag mute" title="Silenciado"><svg class="icon"><use href="#i-bell-off"/></svg></span>` : ''}`;
      return `<button class="convo ${active ? 'active' : ''} ${group ? 'is-group' : ''} ${og && !inThis ? 'has-call' : ''}" data-key="${esc(key)}">
        <div class="avatar" style="--h:${hueOf(group ? group.id : key)}">${avInner}</div>
        <div class="convo-main">
          <div class="convo-top"><strong>${esc(name)}</strong><span class="convo-tag">${tags}</span><span class="convo-time">${last ? fmtDay(last.ts) : ''}</span></div>
          <div class="convo-bot"><span class="convo-prev">${og && !inThis ? `<svg class="ic-mini"><use href="#i-phone"/></svg> ` : ''}${esc(prev)}</span>${un ? `<span class="unread">${un > 99 ? '99+' : un}</span>` : ''}</div>
        </div>
        ${dot}
        <span class="convo-more" data-ckey="${esc(key)}" title="Opciones del chat" role="button" tabindex="0"><svg class="icon"><use href="#i-more"/></svg></span>
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
        <button class="f-ident" data-act="profile" data-uid="${esc(f.uid)}" title="Ver perfil">
          <div class="avatar" style="--h:${hueOf(f.uid)}">${Avatars.html(f.uid, f.name)}</div>
          <div class="f-info"><strong>${esc(f.name)}</strong><span>@${esc(f.uid)}</span></div>
        </button>
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
        <label class="bio-field">Acerca de
          <textarea id="setBio" class="set-input bio" maxlength="200" rows="2" placeholder="Ej. Disponible para hablar de día">${esc(Auth.me.bio || '')}</textarea>
        </label>
        <button id="btnSaveName" class="f-btn add" style="width:100%;justify-content:center;margin-top:10px">Guardar cambios</button>
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
        <button id="btnTestNotif" class="f-btn chat" style="width:100%;justify-content:center;margin-top:10px">Probar notificación (envía un push real)</button>
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
        <h3><svg class="icon"><use href="#i-vibrate"/></svg>Sonido y vibración</h3>
        <p class="desc">Efectos de toda la app: mensajes, reacciones, llamadas y avisos.</p>
        <div class="vol-row">
          <div class="lbl"><strong>Volumen de efectos</strong><span id="volVal">${Math.round((Settings.volume != null ? Settings.volume : 0.8) * 100)}%</span></div>
          <input type="range" id="setVolume" min="0" max="100" step="5" value="${Math.round((Settings.volume != null ? Settings.volume : 0.8) * 100)}" aria-label="Volumen de efectos">
        </div>
        <div class="set-row">
          <div class="lbl"><strong>Vibración</strong><span>Aviso con vibración en móvil (si lo soporta)</span></div>
          <label class="sw"><input type="checkbox" data-set="vibrate" ${Settings.vibrate ? 'checked' : ''}><i></i></label>
        </div>
        <button id="btnTestSound" class="f-btn chat" style="width:100%;justify-content:center;margin-top:10px">Probar efectos de sonido</button>
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
    const inCall = typeof Calls !== 'undefined' && Calls.inCall();
    document.title = (total ? `(${total}) ` : '') + 'Nexo · Chat' + (inCall ? ' · en llamada' : '');
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
    else if (kind === 'gcall') { if (typeof Calls !== 'undefined') Calls.onCallState(p[3], m); }
    /* reacciones con emoji (retenidas por mensaje) */
    else if (kind === 'rx' && p[3] === Auth.me.uid) Chat.handleReaction(p[4], p[5], m, topic);
    else if (kind === 'grx') Chat.handleReaction('g:' + p[3], p[5], m, topic);
    /* descriptor de grupo (nombre, miembros, FOTO) en vivo */
    else if (kind === 'group') { if (typeof Groups !== 'undefined') Groups.onDescriptor(p[3], m); }
    else if (kind === 'ginv' && p[3] === Auth.me.uid) Groups.onInvite(p[4], m);
    else if (kind === 'freq' && p[3] === Auth.me.uid) Friends.handleRequest(p[4], m);
    else if (kind === 'fresp' && p[3] === Auth.me.uid) Friends.handleResponse(p[4], m);
    else if (kind === 'evt' && p[3] === Auth.me.uid) this.handleEvt(m);
    else if (kind === 'presence') Presence.update(p[3], m);
    else if (kind === 'profile') Friends.onProfile(p[3], m);
  },
  handleEvt(m) {
    if (!m || !m.t) return;
    if (m.t === 'ack') Chat.markAcked(m.id, m.from);
    else if (m.t === 'gack') Chat.ackFrom(m.from, m.id);
    else if (m.t === 'typing') Chat.showTyping(m.from, m.name || m.from);
    else if (m.t === 'unfriend') Friends.onUnfriend(m.from);
    else if (m.t === 'gleft') Groups.onMemberLeft(m);
    else if (m.t === 'ginvite') Groups.onInvite(m.gid, { gid: m.gid, name: m.name, from: m.from, fromName: m.fromName });
    else if (m.t === 'gcall') { if (typeof Calls !== 'undefined') Calls.onGroupInvite(m); }
    else if (m.t === 'callmedia') { if (typeof Calls !== 'undefined') Calls.onMediaEvt(m); }
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

    /* lista de conversaciones (DM + grupos): abrir u opciones */
    $('#convoList').addEventListener('click', (e) => {
      if (Date.now() - (window.__lpAt || 0) < 500) return; /* tras pulsación larga */
      const more = e.target.closest('.convo-more');
      if (more) { e.stopPropagation(); ConvoMenu.open(more.dataset.ckey, more); return; }
      const b = e.target.closest('.convo');
      if (b) App.openChat(b.dataset.key);
    });
    $('#convoList').addEventListener('contextmenu', (e) => {
      const c = e.target.closest('.convo');
      if (!c) return;
      e.preventDefault();
      ConvoMenu.open(c.dataset.key, c);
    });

    /* crear grupo */
    $('#btnNewGroup').addEventListener('click', () => Groups.openCreateModal());

    /* cabecera del chat → perfil (DM) o miembros (grupo) */
    $('#chatPeer').addEventListener('click', () => {
      const k = Chat.kind(Chat.active);
      if (k.type === 'group' && k.gid) Groups.openMembersModal(k.gid);
      else if (k.uid) ProfileCard.open(k.uid);
    });
    $('#btnLeaveGroup').addEventListener('click', () => {
      const k = Chat.kind(Chat.active);
      if (k.type !== 'group' || !k.gid) return;
      const g = Groups.get(k.gid);
      UI.confirm('Salir del grupo', `¿Seguro que quieres salir de «${g ? g.name : ''}»?`, 'Salir', true)
        .then((ok) => { if (ok) Groups.leave(k.gid); });
    });

    /* mi avatar del lateral → mi perfil */
    $('#myAvatar').addEventListener('click', () => ProfileCard.open(Auth.me.uid));

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
      else if (act === 'profile') ProfileCard.open(uid);
      else if (act === 'remove') {
        UI.confirm('Eliminar amigo', `¿Eliminar a ${Friends.name(uid)}? Dejaréis de ser amigos.`, 'Eliminar', true)
          .then((ok) => { if (ok) Friends.removeFriend(uid); });
      }
    });

    /* chat */
    $('#btnBack').addEventListener('click', () => Chat.close());
    $('#btnSend').addEventListener('click', () => Chat.sendText());

    /* MODO ENFOQUE: ocultar la barra lateral (solo chat/juego) */
    $('#btnFocus') && $('#btnFocus').addEventListener('click', () => App.setFocus(true));
    $('#gsFocus') && $('#gsFocus').addEventListener('click', () => App.setFocus(true));
    $('#focusRestore') && $('#focusRestore').addEventListener('click', () => App.setFocus(false));

    /* buscar dentro del chat */
    $('#btnSearchChat') && $('#btnSearchChat').addEventListener('click', () => Chat.toggleSearch());
    $('#chatSearchClose') && $('#chatSearchClose').addEventListener('click', () => Chat.closeSearch());
    const searchTimer = { t: null };
    $('#chatSearchInput') && $('#chatSearchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimer.t);
      const v = e.target.value;
      searchTimer.t = setTimeout(() => Chat.runSearch(v), 170);
    });

    /* responder: cancelar la vista previa */
    $('#replyCancel') && $('#replyCancel').addEventListener('click', () => Chat.clearReply());

    /* selector de emojis */
    $('#btnEmoji') && $('#btnEmoji').addEventListener('click', () => Emoji.togglePanel());
    $('#emojiClose') && $('#emojiClose').addEventListener('click', () => Emoji.closePanel());
    $('#emojiPanel') && $('#emojiPanel').addEventListener('click', (e) => {
      const tab = e.target.closest('.emoji-tab');
      if (tab) { Emoji.setTab(tab.dataset.cat); return; }
      const cell = e.target.closest('.emoji-cell');
      if (cell && cell.dataset.emoji) Emoji.insert(cell.dataset.emoji);
    });

    /* FOTO DEL GRUPO (input estático del panel) */
    $('#gPhotoInput') && $('#gPhotoInput').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      const gid = e.target.dataset.gid;
      e.target.value = '';
      if (!f || !gid) return;
      try { await Groups.setPhoto(gid, f); } catch (ex) { UI.toast(ex.message || 'No se pudo cambiar la foto del grupo.'); }
    });

    /* menú contextual compartido (#ctxMenu) */
    $('#ctxMenu') && $('#ctxMenu').addEventListener('click', (e) => {
      const rx = e.target.closest('.ctx-rx');
      if (rx) { MsgMenu.act(null, rx.dataset.mrx); return; }
      const it = e.target.closest('[data-mact]');
      if (it) { MsgMenu.act(it.dataset.mact, null); return; }
      const ci = e.target.closest('[data-cact]');
      if (ci) ConvoMenu.act(ci.dataset.cact);
    });
    document.addEventListener('click', (e) => {
      if (Date.now() - (window.__lpAt || 0) < 500) return; /* no cerrar tras pulsación larga */
      const menu = $('#ctxMenu');
      if (menu && !menu.hidden && !e.target.closest('#ctxMenu')) { MsgMenu.close(); ConvoMenu.close(); }
    });

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

    /* stickers: selector, añadir y pestañas */
    $('#btnSticker').addEventListener('click', () => { if (typeof Emoji !== 'undefined' && Emoji.closePanel) Emoji.closePanel(); Stickers.togglePicker(); });
    $('#stkClose').addEventListener('click', () => Stickers.closePicker());
    $('#stkPanel').addEventListener('click', (e) => {
      const tab = e.target.closest('.stk-tab');
      if (tab) { Stickers.setTab(tab.dataset.tab); return; }
      Stickers.onPickerClick(e);
    });
    $('#stkAddBtn') && $('#stkAddBtn').addEventListener('click', () => $('#stkInput').click());
    $('#stkInput').addEventListener('change', (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      if (files.length) Stickers.addFiles(files);
    });

    /* al hacer clic en los mensajes: menú, citas, reacciones, stickers, media, voz y PERFILES */
    $('#messages').addEventListener('click', (e) => {
      if (Date.now() - (window.__lpAt || 0) < 500) return; /* tras pulsación larga */
      /* botón ⋮ → menú del mensaje (responder / reaccionar / eliminar…) */
      const more = e.target.closest('.msg-more');
      if (more && more.dataset.more) { e.stopPropagation(); MsgMenu.open(Chat.active, more.dataset.more, more); return; }
      /* cita → saltar al mensaje original */
      const quote = e.target.closest('.quote');
      if (quote && quote.dataset.reid) { Chat.jumpTo(quote.dataset.reid); return; }
      /* chip de reacción → poner/quitar mi reacción con ese emoji */
      const chip = e.target.closest('.rx-chip');
      if (chip) {
        const row = chip.closest('.msg-row');
        if (row && row.dataset.mid) Chat.react(Chat.active, row.dataset.mid, chip.dataset.rx);
        return;
      }
      /* avatar o nombre del autor (grupos) → ver su perfil */
      const pu = e.target.closest('[data-puid]');
      if (pu && pu.dataset.puid) { ProfileCard.open(pu.dataset.puid); return; }
      const fav = e.target.closest('.stk-fav');
      if (fav) {
        const id = fav.dataset.fav;
        const m = (Chat.hist(Chat.active) || []).find((x) => x.id === id);
        if (m) Stickers.favFromMessage(m);
        return;
      }
      const img = e.target.closest('.msg-img');
      if (img && img.src) { App.openLightbox(img.src); return; }
      const stk = e.target.closest('.msg-stk');
      if (stk && stk.src) { App.openLightbox(stk.src); return; }
      const play = e.target.closest('.v-play');
      if (play) { Chat.toggleVoice(play.dataset.vid, play); return; }
      const spd = e.target.closest('.v-speed');
      if (spd) Chat.cycleVoiceSpeed(spd.dataset.vid, spd);
      if (!$('#stkPanel').hidden) Stickers.closePicker();
      if ($('#emojiPanel') && !$('#emojiPanel').hidden) Emoji.closePanel();
    });

    /* clic derecho sobre un mensaje → menú completo (estilo WhatsApp Web) */
    $('#messages').addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.msg-row');
      if (!row || !row.dataset.mid) return;
      e.preventDefault();
      MsgMenu.open(Chat.active, row.dataset.mid, row);
    });

    /* pulsación larga (táctil) → menú de mensaje o de conversación */
    this._armLongPress($('#messages'), '.msg-row', (row) => {
      if (row.dataset.mid) MsgMenu.open(Chat.active, row.dataset.mid, row);
    });
    this._armLongPress($('#convoList'), '.convo', (c) => ConvoMenu.open(c.dataset.key, c));

    /* llamadas (1:1 y grupo) */
    $('#btnCallAudio').addEventListener('click', () => Chat.active && !String(Chat.active).startsWith('g:') && Calls.start(Chat.active, false));
    $('#btnCallVideo').addEventListener('click', () => Chat.active && !String(Chat.active).startsWith('g:') && Calls.start(Chat.active, true));
    $('#btnGrpCallAudio').addEventListener('click', () => {
      const k = Chat.kind(Chat.active);
      if (k.type === 'group' && k.gid) Calls.startGroup(k.gid, false);
    });
    $('#btnGrpCallVideo').addEventListener('click', () => {
      const k = Chat.kind(Chat.active);
      if (k.type === 'group' && k.gid) Calls.startGroup(k.gid, true);
    });
    $('#callControls').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'accept') Calls.accept();
      else if (act === 'decline') Calls.decline();
      else if (act === 'hangup') Calls.hangup();
      else if (act === 'mic') Calls.toggleMic();
      else if (act === 'cam') Calls.toggleCam();
      else if (act === 'screen') Calls.toggleScreen();
      else if (act === 'pin') Calls.toggleP2PPin();
      else if (act === 'minimize') Calls.minimize();
    });
    /* banner de llamada en segundo plano */
    $('#cbReturn').addEventListener('click', () => Calls.restore());
    $('#cbHangup').addEventListener('click', () => Calls.hangup());

    /* UNIRSE a una llamada de grupo en curso */
    $('#gcJoin') && $('#gcJoin').addEventListener('click', () => {
      const k = Chat.kind(Chat.active);
      if (k.type === 'group' && k.gid) Calls.joinGroup(k.gid);
    });

    /* JUEGOS: tarjetas del panel + escenario (iframe) en la zona principal */
    $('#viewGames') && $('#viewGames').addEventListener('click', (e) => {
      const card = e.target.closest('[data-game]');
      if (card) { Games.open(card.dataset.game); return; }
      const ext = e.target.closest('[data-ext]');
      if (ext) { window.open(ext.dataset.ext, '_blank', 'noopener'); }
    });
    $('#gsBack') && $('#gsBack').addEventListener('click', () => Games.close());
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
      if (e.target.id === 'setVolume') {
        const pct = parseInt(e.target.value, 10) || 0;
        Settings.volume = pct / 100;
        saveSettings();
        const lbl = $('#volVal');
        if (lbl) lbl.textContent = pct + '%';
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
          await Auth.updateBio(($('#setBio') && $('#setBio').value) || '');
          UI.toast('Perfil actualizado: tus amigos verán los cambios al instante.');
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
        /* prueba REAL: push Web completo hacia mi propia suscripción
           (emisor → push service → Service Worker → notificación) */
        let pushed = false;
        try {
          pushed = await Push.notify(Auth.me.uid, 'Notificación de prueba de Nexo',
            'Así te avisaremos de tus mensajes con la app cerrada.',
            { chat: Chat.active || '', name: Auth.me.name, test: true }, { force: true });
        } catch (e) {}
        if (!pushed) {
          /* sin suscripción push: mostrar la notificación local clásica */
          Notify.browser('Notificación de prueba de Nexo', 'Así se verán tus avisos de mensajes.', { name: Auth.me.name });
          UI.toast('Prueba local enviada (activa el push para probar también sin abrir la app).');
        } else {
          UI.toast('Push real enviado: debería aparecer aunque cierres Nexo.');
        }
        if (Settings.sound) Sound.msg();
      } else if (btn.id === 'btnTestSound') {
        /* pequeña demo del banco de sonidos v6 */
        if (Settings.sound) {
          Sound.send();
          setTimeout(() => Sound.msg(), 420);
          setTimeout(() => Sound.react(), 900);
          setTimeout(() => Sound.chime(), 1400);
          setTimeout(() => Sound.connect(), 2100);
          setTimeout(() => Sound.hangup(), 2900);
        } else UI.toast('Activa «Sonidos» para oír la demo.');
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
        if (d.nexoPushedNotif) {
          /* push recibido con la app visible: el SW lo marcó silencioso
             porque aquí dentro ya avisamos — confirmación discreta */
          const t = d.nexoPushedNotif.title || 'Nexo';
          UI.toast(`Push entrante: ${t}`, { icon: 'bell' });
        }
      });
    }

    /* al volver a la pestaña: limpiar no leídos del chat activo */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Auth.me && Chat.active) Chat.clearUnread(Chat.active);
    });
  },

  /* pulsación larga (táctil) → menú contextual, sin interferir con el scroll */
  _armLongPress(container, selector, open) {
    if (!container) return;
    let timer = null;
    const pos = { x: 0, y: 0 };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    container.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return; /* escritorio: ⋮ o clic derecho */
      const target = e.target.closest(selector);
      if (!target) return;
      pos.x = e.clientX; pos.y = e.clientY;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
        open(target);
      }, 470);
    });
    container.addEventListener('pointermove', (e) => {
      if (timer && (Math.abs(e.clientX - pos.x) > 10 || Math.abs(e.clientY - pos.y) > 10)) cancel();
    });
    container.addEventListener('pointerup', cancel);
    container.addEventListener('pointercancel', cancel);
    container.addEventListener('scroll', cancel, { capture: true, passive: true });
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
