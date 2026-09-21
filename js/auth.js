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
    Mqtt.publish(T.profile(u), { uid: u, name, updated: Date.now() }, { retain: true });

    LS.set(K.session, { uid: u, name, salt, hash, iters: PBKDF2_ITERS });
    this.me = { uid: u, name };
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
    /* recuperar el perfil (nombre + foto) publicado por el usuario */
    const prof = await Mqtt.fetchRetained(T.profile(u), 2200);
    const av = (prof && prof.av) || null;
    /* auto-reparar el perfil retenido por si el broker lo perdió */
    Mqtt.publish(T.profile(u), { uid: u, name, av: av || undefined, updated: Date.now() }, { retain: true });

    LS.set(K.session, { uid: u, name, av: av || undefined, salt: rec.salt, hash, iters: rec.iters || PBKDF2_ITERS });
    this.me = { uid: u, name, av: av || undefined };
    return true;
  },

  /* ---- sesión guardada ---- */
  resume() {
    const s = this.session();
    if (s && s.uid && s.name) {
      this.me = { uid: s.uid, name: s.name, av: s.av || undefined };
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
            Mqtt.publish(T.profile(uid), { uid, name: Auth.me.name, av: Auth.me.av || undefined, updated: Date.now() }, { retain: true });
            if (Push.sub) Push.publishSub();
          };
          /* re-publicar identidad (auto-reparación del directorio) */
          Mqtt.publish(T.profile(uid), { uid, name: this.me.name, av: this.me.av || undefined, updated: Date.now() }, { retain: true });
          Presence.goOnline();
          Presence.startTimers();

          /* bandeja offline + solicitudes + respuestas + eventos + grupos */
          Mqtt.sub([
            `${NS}/dm/${uid}/#`,
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
    Mqtt.publish(T.profile(s.uid), { uid: s.uid, name, av: this.me.av || undefined, updated: Date.now() }, { retain: true });
    App.renderMyAvatar();
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
    Mqtt.publish(T.profile(this.me.uid), { uid: this.me.uid, name: this.me.name, av: dataURL, updated: Date.now() }, { retain: true });
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
    Mqtt.publish(T.profile(this.me.uid), { uid: this.me.uid, name: this.me.name, av: '', updated: Date.now() }, { retain: true });
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
