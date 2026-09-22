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

  /* ---- un contacto CAMBIÓ SU USUARIO (en vivo por evt «rename» o al
     reconectar por el puntero retenido «moved» de su presencia antigua).
     Migra su uid en mis datos locales: amigos, historial, no leídos,
     avatar, fijados/silenciados y notificaciones. La conversación abierta
     (si la hay) se re-apunta sin cerrarse.                              */
  onRename(old, nu, name) {
    if (!old || !nu || old === nu || !Auth.me || nu === Auth.me.uid) return;
    const list = this.all();
    const f = list.find((x) => x.uid === old);
    if (!f) return; /* ya migrado antes (el puntero retenido se re-entrega) */
    f.uid = nu;
    if (name) f.name = name;
    this.save(list);
    this._migratePeerLocal(old, nu);
    Presence.unwatch(old);
    Presence.watch(nu);
    if (Chat.active === old) {
      Chat.active = nu;
      Chat.renderHeaderInfo(nu);
      Chat.renderMessages(nu);
    }
    App.renderAll();
    UI.toast(`${f.name} cambió su usuario a @${nu}.`);
  },

  /* migración local de TODO lo que apunta al uid antiguo de un contacto */
  _migratePeerLocal(old, nu) {
    if (!Auth.me) return;
    /* historial del chat con esa persona */
    const ho = K.hist(Auth.me.uid, old), hn = K.hist(Auth.me.uid, nu);
    const h = LS.get(ho, null);
    if (h != null) { LS.set(hn, h); LS.del(ho); }
    /* caché en memoria del chat abierto */
    if (Chat._cache[old] && !Chat._cache[nu]) { Chat._cache[nu] = Chat._cache[old]; }
    delete Chat._cache[old];
    /* no leídos */
    const uKey = K.unread(Auth.me.uid);
    const u = LS.get(uKey, {});
    if (u[old] != null) { if (u[nu] == null) u[nu] = u[old]; delete u[old]; LS.set(uKey, u); }
    /* avatar cacheado bajo el uid antiguo */
    const aKey = K.avatars(Auth.me.uid);
    const a = LS.get(aKey, {});
    if (a[old]) { if (!a[nu]) a[nu] = a[old]; delete a[old]; LS.set(aKey, a); }
    /* chats fijados / silenciados (preferencias por chat) */
    let pref = false;
    if (Settings.pinned && Settings.pinned[old]) { Settings.pinned[nu] = true; delete Settings.pinned[old]; pref = true; }
    if (Settings.muted && Settings.muted[old]) { Settings.muted[nu] = Settings.muted[old]; delete Settings.muted[old]; pref = true; }
    if (pref && typeof saveSettings === 'function') saveSettings();
    /* centro de notificaciones: rutas hacia el chat antiguo */
    try {
      const nKey = K.notifs(Auth.me.uid);
      const n = LS.get(nKey, []);
      let nch = false;
      n.forEach((it) => { if (it && it.chat === old) { it.chat = nu; nch = true; } });
      if (nch) LS.set(nKey, n);
    } catch (e) {}
    /* ventana anti-spam en memoria */
    if (typeof Spam !== 'undefined' && Spam._win && Spam._win.has(old)) {
      Spam._win.set(nu, Spam._win.get(old));
      Spam._win.delete(old);
    }
  },

  /* ---- actualización del perfil de un amigo (nombre, foto y/o bio) ----
     El perfil retenido nexo/v1/profile/<uid> llega por la suscripción
     de presencia: cambió la foto o la bio → refrescar todas las vistas.  */
  onProfile(uid, m) {
    if (!m || !m.uid || uid === (Auth.me && Auth.me.uid)) return;
    if (!this.isFriend(uid)) return;
    /* mutar y guardar EL MISMO array (all() re-parsea localStorage:
     guardar un parse distinto perdería los cambios silenciosamente) */
    const list = this.all();
    const f = list.find((x) => x.uid === uid);
    if (!f) return;
    let changed = false;
    if (m.name && m.name !== f.name) {
      f.name = m.name;
      changed = true;
    }
    if (typeof m.bio === 'string' && m.bio !== (f.bio || '')) {
      f.bio = m.bio;
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
      this.save(list);
      App.renderAll();
      if (Chat.active === uid) Chat.renderHeaderInfo(uid);
    }
  }
};
