/* auth.js — cuentas reales sin servidor
   - Registro: hash PBKDF2-SHA256 + sal aleatoria, publicado retenido en el broker
     (el directorio de cuentas vive en la red MQTT, no en una BD propia)
   - Login: verifica el hash contra el registro retenido
   - Sesión local (auto-login) con verificación y auto-reparación            */
'use strict';

const Auth = {
  me: null, /* {uid, name} */

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
    /* auto-reparar el perfil retenido por si el broker lo perdió */
    Mqtt.publish(T.profile(u), { uid: u, name, updated: Date.now() }, { retain: true });

    LS.set(K.session, { uid: u, name, salt: rec.salt, hash, iters: rec.iters || PBKDF2_ITERS });
    this.me = { uid: u, name };
    return true;
  },

  /* ---- sesión guardada ---- */
  resume() {
    const s = this.session();
    if (s && s.uid && s.name) {
      this.me = { uid: s.uid, name: s.name };
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
            Mqtt.publish(T.profile(uid), { uid, name: Auth.me.name, updated: Date.now() }, { retain: true });
          };
          /* re-publicar identidad (auto-reparación del directorio) */
          Mqtt.publish(T.profile(uid), { uid, name: this.me.name, updated: Date.now() }, { retain: true });
          Presence.goOnline();
          Presence.startTimers();

          /* bandeja offline + solicitudes + respuestas + eventos */
          Mqtt.sub([
            `${NS}/dm/${uid}/#`,
            `${NS}/freq/${uid}/+`,
            `${NS}/fresp/${uid}/+`,
            T.evt(uid)
          ]);
          Friends.all().forEach((f) => Presence.watch(f.uid));

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
    Mqtt.publish(T.profile(s.uid), { uid: s.uid, name, updated: Date.now() }, { retain: true });
    App.renderMyAvatar();
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
