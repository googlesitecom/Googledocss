/* friends.js — sistema de amistad con consentimiento
   - Búsqueda por nombre de usuario exacto (perfil retenido en el broker)
   - Solicitud → el OTRO debe ACEPTAR para establecer la amistad
   - Solicitudes y respuestas retenidas: funcionan aunque el otro esté desconectado
   - Eliminar amigo se notifica por evento en vivo                          */
'use strict';

const Friends = {
  _pendingIn: new Map(), /* uid -> {name, ts} solicitudes recibidas */

  all() { return Auth.me ? LS.get(K.friends(Auth.me.uid), []) : []; },
  save(l) { if (Auth.me) LS.set(K.friends(Auth.me.uid), l); },
  isFriend(uid) { return this.all().some((f) => f.uid === uid); },
  name(uid) { const f = this.all().find((x) => x.uid === uid); return f ? f.name : uid; },
  friend(uid) { return this.all().find((x) => x.uid === uid) || null; },

  pendingOut() { return Auth.me ? LS.get(K.pout(Auth.me.uid), []) : []; },
  saveOut(l) { if (Auth.me) LS.set(K.pout(Auth.me.uid), l); },

  /* ---- búsqueda de cuenta ---- */
  async search(q) {
    const u = String(q || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(u)) return { err: 'Escribe un usuario válido (3-20: a-z, 0-9, _).' };
    if (Auth.me && u === Auth.me.uid) return { err: 'Ese usuario eres tú.' };
    const prof = await Mqtt.fetchRetained(T.profile(u), 2800);
    if (!prof) return { err: 'No existe ninguna cuenta con ese usuario.' };
    return { prof };
  },

  /* ---- enviar solicitud ---- */
  sendRequest(prof) {
    const u = prof.uid;
    if (!u || this.isFriend(u) || (Auth.me && u === Auth.me.uid)) return;
    if (this.pendingOut().some((p) => p.uid === u)) return;
    Mqtt.publish(T.freq(u, Auth.me.uid), { from: Auth.me.uid, name: Auth.me.name, ts: Date.now() }, { retain: true, expiry: 2592000 });
    const out = this.pendingOut();
    out.push({ uid: u, name: prof.name || u, ts: Date.now() });
    this.saveOut(out);
    App.renderFriends();
    UI.toast(`Solicitud enviada a ${prof.name || u}. Debe aceptarla para chatear.`);
    /* push si está desconectado: se entera sin abrir la app */
    if (!Presence.isOnline(u)) {
      Push.notify(u, 'Nueva solicitud de amistad', `${Auth.me.name} quiere ser tu amigo`, { friends: true });
    }
  },

  /* ---- recepción de solicitud (en vivo o retenida al conectar) ---- */
  handleRequest(from, m) {
    if (!m || !m.from || from === (Auth.me && Auth.me.uid)) return;
    if (this.isFriend(from)) {
      /* ya somos amigos (p. ej. aceptada en otro dispositivo): limpiar retenido */
      Mqtt.publish(T.freq(Auth.me.uid, from), '', { retain: true });
      return;
    }
    this._pendingIn.set(from, { name: m.name || from, ts: m.ts || Date.now() });
    App.renderFriends();
    Notify.onFriendRequest({ from, name: m.name || from });
  },

  accept(from) {
    const p = this._pendingIn.get(from);
    if (!p) return;
    this._pendingIn.delete(from);
    this.addFriend(from, p.name);
    Mqtt.publish(T.fresp(from, Auth.me.uid), { accepted: true, from: Auth.me.uid, name: Auth.me.name, ts: Date.now() }, { retain: true, expiry: 2592000 });
    Mqtt.publish(T.freq(Auth.me.uid, from), '', { retain: true }); /* limpiar solicitud */
    Presence.watch(from);
    App.renderAll();
    UI.toast(`¡Ya son amigos tú y ${p.name}!`);
    Sound.chime();
    /* push al solicitante si está desconectado */
    if (!Presence.isOnline(from)) {
      Push.notify(from, 'Solicitud aceptada', `${Auth.me.name} aceptó tu solicitud de amistad`, { friends: true });
    }
  },

  reject(from) {
    const p = this._pendingIn.get(from);
    if (!p) return;
    this._pendingIn.delete(from);
    Mqtt.publish(T.fresp(from, Auth.me.uid), { accepted: false, from: Auth.me.uid, name: Auth.me.name, ts: Date.now() }, { retain: true, expiry: 2592000 });
    Mqtt.publish(T.freq(Auth.me.uid, from), '', { retain: true });
    App.renderFriends();
  },

  /* ---- respuesta del destinatario (para quien envió la solicitud) ---- */
  handleResponse(from, m) {
    Mqtt.publish(T.fresp(Auth.me.uid, from), '', { retain: true }); /* limpiar */
    this.saveOut(this.pendingOut().filter((p) => p.uid !== from));
    if (m && m.accepted) {
      this.addFriend(from, (m && m.name) || from);
      Presence.watch(from);
      Notify.onAccepted({ from, name: (m && m.name) || from });
      App.renderAll();
    } else {
      Notify.onRejected({ from, name: (m && m.name) || from });
      App.renderFriends();
    }
  },

  addFriend(uid, name) {
    if (!uid || this.isFriend(uid) || uid === (Auth.me && Auth.me.uid)) return;
    const l = this.all();
    l.push({ uid, name: name || uid, since: Date.now() });
    this.save(l);
  },

  removeFriend(uid) {
    const name = this.name(uid);
    this.save(this.all().filter((f) => f.uid !== uid));
    Mqtt.publish(T.evt(uid), { t: 'unfriend', from: Auth.me.uid });
    Presence.unwatch(uid);
    if (Chat.active === uid) Chat.close();
    App.renderAll();
    UI.toast(`Eliminaste a ${name} de tus amigos.`);
  },

  onUnfriend(from) {
    const name = this.name(from);
    this.save(this.all().filter((f) => f.uid !== from));
    Presence.unwatch(from);
    if (Chat.active === from) Chat.close();
    App.renderAll();
    UI.toast(`${name} eliminó la amistad contigo.`);
  },

  /* ---- actualización del perfil de un amigo (nombre y/o foto) ----
     El perfil retenido nexo/v1/profile/<uid> llega por la suscripción
     de presencia: cambió la foto → refrescar todas las vistas.        */
  onProfile(uid, m) {
    if (!m || !m.uid || uid === (Auth.me && Auth.me.uid)) return;
    if (!this.isFriend(uid)) return;
    const f = this.friend(uid);
    let changed = false;
    if (m.name && m.name !== f.name) {
      f.name = m.name;
      this.save(this.all());
      changed = true;
    }
    if (m.av) {
      Avatars.set(uid, m.av);
      changed = true;
    } else if (m.av === '' && Avatars.get(uid)) {
      Avatars.remove(uid);
      changed = true;
    }
    if (changed) {
      App.renderAll();
      if (Chat.active === uid) Chat.renderHeaderInfo(uid);
    }
  }
};
