/* auth.js — cuentas reales sin servidor
   - Registro: hash PBKDF2-SHA256 + sal aleatoria, publicado retenido en el broker
     (el directorio de cuentas vive en la red MQTT, no en una BD propia)
   - Login: verifica el hash contra el registro retenido y recupera el perfil
     (nombre + FOTO DE PERFIL) publicado por el usuario
   - Sesión local (auto-login) con verificación y auto-reparación
   - Al conectar: presencia, bandejas, grupos y Service Worker de push        */
'use strict';

const Auth = {
  me: null, /* {uid, name, av} */

  session() { return LS.get(K.session, null); },

  /* ---- fase 1: conexión anónima para registrar / entrar ---- */
  startAnonConnection() {
    return new Promise((resolve) => {
      Mqtt.connect({
        uid: null,
        onReady: resolve,
        onMessage: () => {},
        onStatus: (s) => App.setAuthConn(s)
      });
    });
  },

  /* ---- registro ---- */
  async register(u, name, pwd) {
    u = String(u || '').trim().toLowerCase();
    name = String(name || '').trim();
    if (!/^[a-z0-9_]{3,20}$/.test(u)) throw new Error('El usuario debe tener 3-20 caracteres: letras minúsculas, números o _.');
    if (name.length < 2 || name.length > 32) throw new Error('El nombre para mostrar debe tener entre 2 y 32 caracteres.');
    if (pwd.length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres.');

    const existing = await Mqtt.fetchRetained(T.auth(u), 2600);
    if (existing) throw new Error('Ese nombre de usuario ya está en uso.');

    const salt = randomHex(16);
    const hash = await deriveKey(pwd, salt, PBKDF2_ITERS);

    Mqtt.publish(T.auth(u), { salt, hash, iters: PBKDF2_ITERS, name, created: Date.now() }, { retain: true });
    Mqtt.publish(T.profile(u), { uid: u, name, bio: '', updated: Date.now() }, { retain: true });

    LS.set(K.session, { uid: u, name, salt, hash, iters: PBKDF2_ITERS });
    this.me = { uid: u, name, bio: '' };
    return true;
  },

  /* ---- login ---- */
  async login(u, pwd) {
    u = String(u || '').trim().toLowerCase();
    if (!u || !pwd) throw new Error('Completa todos los campos.');

    const rec = await Mqtt.fetchRetained(T.auth(u), 3200);
    if (!rec) throw new Error('Cuenta no encontrada. ¿Ya te registraste?');

    const hash = await deriveKey(pwd, rec.salt, rec.iters || PBKDF2_ITERS);
    if (hash !== rec.hash) throw new Error('Contraseña incorrecta.');

    const name = rec.name || u;
    /* recuperar el perfil (nombre + foto + bio) publicado por el usuario */
    const prof = await Mqtt.fetchRetained(T.profile(u), 2200);
    const av = (prof && prof.av) || null;
    const bio = (prof && prof.bio) || '';
    /* auto-reparar el perfil retenido por si el broker lo perdió */
    Mqtt.publish(T.profile(u), { uid: u, name, av: av || undefined, bio, updated: Date.now() }, { retain: true });

    LS.set(K.session, { uid: u, name, av: av || undefined, bio, salt: rec.salt, hash, iters: rec.iters || PBKDF2_ITERS });
    this.me = { uid: u, name, av: av || undefined, bio };
    return true;
  },

  /* ---- sesión guardada ---- */
  resume() {
    const s = this.session();
    if (s && s.uid && s.name) {
      this.me = { uid: s.uid, name: s.name, av: s.av || undefined, bio: s.bio || '' };
      return true;
    }
    return false;
  },

  /* ---- fase 2: conexión con identidad (LWT + suscripciones) ---- */
  startAppConnection() {
    return new Promise((resolve) => {
      Mqtt.connect({
        uid: this.me.uid,
        onReady: () => {
          const uid = this.me.uid;
          Mqtt._onReconnect = () => {
            Presence.goOnline();
            Mqtt.publish(T.profile(uid), { uid, name: Auth.me.name, av: Auth.me.av || undefined, bio: Auth.me.bio || '', updated: Date.now() }, { retain: true });
            if (Push.sub) Push.publishSub();
          };
          /* re-publicar identidad (auto-reparación del directorio) */
          Mqtt.publish(T.profile(uid), { uid, name: this.me.name, av: this.me.av || undefined, bio: this.me.bio || '', updated: Date.now() }, { retain: true });
          Presence.goOnline();
          Presence.startTimers();

          /* recién cambiado el usuario: re-publicar el puntero «moved»
             (el LWT de la conexión anterior pudo pisarlo al recargar) y
             tender un puente DM/rx temporal hacia el usuario antiguo      */
          const s0 = this.session();
          const prev = s0 && s0.prev;
          if (prev) {
            Mqtt.publish(T.presence(prev), { online: false, moved: uid, name: this.me.name, ts: Date.now() }, { retain: true, expiry: 2592000 });
            delete s0.prev;
            LS.set(K.session, s0);
            Mqtt.sub([`${NS}/dm/${prev}/#`, `${NS}/rx/${prev}/#`]);
            App._oldUid = prev;
            setTimeout(() => {
              App._oldUid = null;
              Mqtt.unsub(`${NS}/dm/${prev}/#`);
              Mqtt.unsub(`${NS}/rx/${prev}/#`);
            }, 120000);
          }

          /* bandeja offline + solicitudes + respuestas + eventos + grupos
             + reacciones de DM dirigidas a mí (retenidas) */
          Mqtt.sub([
            `${NS}/dm/${uid}/#`,
            `${NS}/rx/${uid}/#`,
            `${NS}/freq/${uid}/+`,
            `${NS}/fresp/${uid}/+`,
            T.evt(uid)
          ]);
          Groups.subscribeAll();
          Friends.all().forEach((f) => Presence.watch(f.uid));

          /* Service Worker + push (notificaciones con la app cerrada) */
          Push.init().then(() => { if (Push.sub) Push.publishSub(); }).catch(() => {});

          Calls.init();
          Notify.load();
          this.verifyRecord();
          resolve();
        },
        onMessage: (t, s) => App.routeMessage(t, s),
        onStatus: (s) => App.setConn(s)
      });
    });
  },

  /* verificación en segundo plano de la sesión auto-iniciada */
  async verifyRecord() {
    try {
      const s = this.session();
      if (!s) return;
      const rec = await Mqtt.fetchRetained(T.auth(s.uid), 3200);
      if (rec && rec.hash && rec.hash !== s.hash) {
        this.forceLogout('Tu cuenta fue modificada desde otro dispositivo. Vuelve a iniciar sesión.');
      } else if (!rec) {
        /* el broker perdió el registro: lo re-publicamos desde la sesión local */
        Mqtt.publish(T.auth(s.uid), { salt: s.salt, hash: s.hash, iters: s.iters, name: s.name, created: Date.now() }, { retain: true });
      }
    } catch (e) { console.warn('verifyRecord', e); }
  },

  async updateName(name) {
    name = String(name || '').trim();
    if (name.length < 2 || name.length > 32) throw new Error('El nombre debe tener entre 2 y 32 caracteres.');
    const s = this.session();
    if (!s) return;
    this.me.name = name;
    s.name = name;
    LS.set(K.session, s);
    Mqtt.publish(T.auth(s.uid), { salt: s.salt, hash: s.hash, iters: s.iters, name, created: Date.now() }, { retain: true });
    Mqtt.publish(T.profile(s.uid), { uid: s.uid, name, av: this.me.av || undefined, bio: this.me.bio || '', updated: Date.now() }, { retain: true });
    App.renderMyAvatar();
  },

  /* ================== CAMBIAR EL USUARIO (pide la contraseña) ==================
     El usuario es la identidad en TODA la red (temas MQTT y ámbito de los
     datos locales), así que el cambio es una migración completa:
       1. confirma la identidad verificando la contraseña actual
       2. comprueba que el nuevo usuario esté libre
       3. publica cuenta + perfil bajo el nuevo usuario (misma contraseña)
       4. re-publica los descriptores de sus grupos con el nuevo uid
       5. avisa EN VIVO a los amigos conectados (evt «rename»)
       6. deja un puntero retenido «moved» en la presencia antigua para los
          amigos desconectados (se re-publica al reconectar; expira a 30 días)
       7. limpia los retenidos antiguos (auth / profile / psub)
       8. migra el almacenamiento local nexo_<old>_* → nexo_<nuevo>_*
     Tras la recarga la app reconecta ya como @nuevo y tiende un puente DM
     temporal hacia el usuario antiguo por si algún amigo tarda en enterarse.  */
  async changeUsername(newU, pwd) {
    newU = String(newU || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(newU)) throw new Error('El usuario debe tener 3-20 caracteres: letras minúsculas, números o _.');
    if (!pwd) throw new Error('Escribe tu contraseña para confirmar el cambio.');
    const s = this.session();
    if (!s) throw new Error('No hay sesión activa.');
    if (newU === s.uid) throw new Error('Ese ya es tu usuario actual.');
    if (typeof Calls !== 'undefined' && Calls.inCall && Calls.inCall())
      throw new Error('Termina la llamada antes de cambiar tu usuario.');

    /* 1) confirmar identidad con la contraseña */
    const hash = await deriveKey(pwd, s.salt, s.iters || PBKDF2_ITERS);
    if (hash !== s.hash) throw new Error('Contraseña incorrecta.');

    /* 2) el nuevo usuario debe estar libre (director global del broker) */
    const taken = await Mqtt.fetchRetained(T.auth(newU), 2600);
    if (taken) throw new Error('Ese nombre de usuario ya está en uso.');

    const old = s.uid;
    const name = this.me.name;
    const created = s.created || Date.now();

    /* 3) cuenta + perfil bajo el nuevo usuario, misma contraseña */
    Mqtt.publish(T.auth(newU), { salt: s.salt, hash: s.hash, iters: s.iters || PBKDF2_ITERS, name, created, prev: old }, { retain: true });
    Mqtt.publish(T.profile(newU), { uid: newU, name, av: this.me.av || undefined, bio: this.me.bio || '', updated: Date.now() }, { retain: true });

    /* 4) grupos: descriptores retenidos con el nuevo uid (miembro y creador) */
    const glist = (typeof Groups !== 'undefined') ? Groups.all() : [];
    glist.forEach((g) => {
      if (Array.isArray(g.members) && g.members.includes(old)) {
        g.members = g.members.map((u) => (u === old ? newU : u));
        if (g.creator === old) g.creator = newU;
        Groups.publishDescriptor(g);
      }
    });
    if (typeof Groups !== 'undefined') Groups.save(glist);

    /* 5) aviso en vivo a los amigos conectados */
    ((typeof Friends !== 'undefined') ? Friends.all() : []).forEach((f) => {
      Mqtt.publish(T.evt(f.uid), { t: 'rename', from: old, to: newU, name });
    });

    /* 6) puntero retenido para los amigos desconectados: lo vuelven a ver
          al reconectar (expira a los 30 días). Se re-publica tras recargar
          porque el LWT de la conexión antigua puede pisarlo.               */
    Mqtt.publish(T.presence(old), { online: false, moved: newU, name, ts: Date.now() }, { retain: true, expiry: 2592000 });

    /* 7) limpiar los retenidos del usuario antiguo */
    Mqtt.publish(T.auth(old), '', { retain: true });
    Mqtt.publish(T.profile(old), '', { retain: true });
    Mqtt.publish(T.psub(old), '', { retain: true });

    /* 8) parar latidos (no deben pisar el puntero) y migrar datos locales */
    if (typeof Presence !== 'undefined' && Presence.stopTimers) Presence.stopTimers();
    Presence.goOffline();
    this._migrateLocal(old, newU);

    /* 9) sesión nueva → la UI recarga y reconecta ya como @nuevo */
    LS.set(K.session, {
      uid: newU, name,
      av: this.me.av || undefined, bio: this.me.bio || '',
      salt: s.salt, hash: s.hash, iters: s.iters || PBKDF2_ITERS,
      created, prev: old
    });
    return true;
  },

  /* migrar el ámbito local de la cuenta: nexo_<old>_* → nexo_<nuevo>_*
     (amigos, solicitudes, historiales, no leídos, grupos, avatares,
     stickers, notificaciones, anti-spam) + el avatar propio en el caché.
     Los historiales se enumeran por amigo/grupo para que el guion bajo
     de los uids no pueda producir colisiones de prefijo.                */
  _migrateLocal(old, nu) {
    try {
      const from = `nexo_${old}_`, to = `nexo_${nu}_`;
      /* claves exactas (sin ambigüedad posible) */
      ['friends', 'pending_out', 'unread', 'notifs', 'spamstats', 'groups_av', 'groups', 'avatars', 'stickers']
        .forEach((sf) => {
          const k = from + sf;
          const v = localStorage.getItem(k);
          if (v != null) { localStorage.setItem(to + sf, v); localStorage.removeItem(k); }
        });
      /* historiales: solo los chats que existen (amigos + grupos) */
      const peers = [];
      try {
        const fr = LS.get(to + 'friends', []);
        fr.forEach((f) => f && f.uid && peers.push(f.uid));
        const gr = LS.get(to + 'groups', []);
        gr.forEach((g) => g && g.id && peers.push('g:' + g.id));
      } catch (e) {}
      peers.forEach((peer) => {
        const k = from + 'hist_' + peer;
        const v = localStorage.getItem(k);
        if (v != null) { localStorage.setItem(to + 'hist_' + peer, v); localStorage.removeItem(k); }
      });
      /* el avatar propio queda cacheado bajo el uid antiguo */
      const avKey = to + 'avatars';
      const c = LS.get(avKey, {});
      if (c[old] && !c[nu]) { c[nu] = c[old]; LS.set(avKey, c); }
    } catch (e) { console.warn('migrateLocal', e); }
  },

  /* ---- modal: cambiar el usuario (solo pide la contraseña) ---- */
  openChangeUserModal() {
    const root = $('#modalRoot');
    if (!root || !this.me) return;
    if (typeof Calls !== 'undefined' && Calls.inCall && Calls.inCall()) {
      UI.toast('Termina la llamada antes de cambiar tu usuario.');
      return;
    }
    root.innerHTML = `
      <div class="modal group-modal">
        <h3>Cambiar tu usuario</h3>
        <p>El usuario es tu identificador único: sirve para iniciar sesión y para que te encuentren. Tus amigos, grupos e historiales se conservan y tu contraseña no cambia.</p>
        <label class="bio-field cu-field">Nuevo usuario
          <input id="cuUser" class="set-input" maxlength="20" placeholder="minúsculas, números y _" spellcheck="false" autocapitalize="off" autocomplete="off">
        </label>
        <label class="bio-field cu-field">Contraseña actual
          <input id="cuPass" class="set-input" type="password" autocomplete="current-password" placeholder="confirma que eres tú">
        </label>
        <p id="cuErr" class="form-err" hidden></p>
        <div class="m-acts">
          <button class="btn-ghost" data-r="0">Cancelar</button>
          <button id="cuOk" class="btn-primary" data-r="1">Cambiar usuario</button>
        </div>
      </div>`;
    root.hidden = false;
    const err = $('#cuErr');
    const inp = $('#cuUser');
    const pass = $('#cuPass');
    const close = () => { root.hidden = true; root.innerHTML = ''; root.onclick = null; };
    const go = async () => {
      if (!$('#cuOk')) return;
      err.hidden = true;
      const btn = $('#cuOk');
      btn.disabled = true;
      btn.textContent = 'Verificando…';
      try {
        await this.changeUsername(inp.value, pass.value);
        UI.toast('¡Usuario cambiado! Reiniciando con tu nueva identidad…');
        btn.textContent = '¡Hecho! Reiniciando…';
        setTimeout(() => location.reload(), 900);
      } catch (ex) {
        err.textContent = ex.message || 'No se pudo cambiar el usuario.';
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Cambiar usuario';
      }
    };
    root.onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === '1') go();
      else close();
    };
    [inp, pass].forEach((i) => { i.onkeydown = (e) => { if (e.key === 'Enter') go(); }; });
    setTimeout(() => inp.focus(), 60);
  },

  /* ---- "acerca de" (bio) del perfil ---- */
  async updateBio(bio) {
    bio = String(bio || '').trim().slice(0, 200);
    const s = this.session();
    if (!s) return;
    this.me.bio = bio;
    s.bio = bio;
    LS.set(K.session, s);
    Mqtt.publish(T.profile(this.me.uid), { uid: this.me.uid, name: this.me.name, av: this.me.av || undefined, bio, updated: Date.now() }, { retain: true });
  },

  /* ---- foto de perfil ---- */
  async setAvatar(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('Elige un archivo de imagen.');
    if (file.size > 12 * 1024 * 1024) throw new Error('La imagen supera 12 MB.');
    let dataURL = null;
    /* comprimir progresivamente hasta un tamaño razonable para el perfil */
    for (const [dim, q] of [[192, 0.75], [160, 0.62], [128, 0.5]]) {
      const { b64 } = await compressImage(file, dim, q);
      dataURL = `data:image/jpeg;base64,${b64}`;
      if (b64.length <= 60000) break;
    }
    if (!dataURL) throw new Error('No se pudo procesar la imagen.');

    const s = this.session();
    if (!s) return;
    this.me.av = dataURL;
    s.av = dataURL;
    LS.set(K.session, s);
    Avatars.set(this.me.uid, dataURL);
    Mqtt.publish(T.profile(this.me.uid), { uid: this.me.uid, name: this.me.name, av: dataURL, bio: this.me.bio || '', updated: Date.now() }, { retain: true });
    App.renderAll();
    UI.toast('Foto de perfil actualizada. Tus amigos la verán al instante.');
  },

  async removeAvatar() {
    const s = this.session();
    if (!s) return;
    this.me.av = undefined;
    delete s.av;
    LS.set(K.session, s);
    Avatars.remove(this.me.uid);
    Mqtt.publish(T.profile(this.me.uid), { uid: this.me.uid, name: this.me.name, av: '', bio: this.me.bio || '', updated: Date.now() }, { retain: true });
    App.renderAll();
    UI.toast('Foto de perfil eliminada.');
  },

  logout() {
    Presence.goOffline();
    LS.del(K.session);
    setTimeout(() => location.reload(), 250);
  },

  forceLogout(msg) {
    try { Mqtt.end(); } catch (e) {}
    LS.del(K.session);
    alert(msg || 'Sesión no válida.');
    location.reload();
  }
};
