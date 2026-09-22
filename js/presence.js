/* presence.js — presencia en línea real
   - Publica "online" retenido al conectar + heartbeat cada 25 s
   - LWT del broker publica "offline" si la conexión muere
   - Un.online se considera vigente 70 s (por si un latido se pierde)
   - Al vigilar a un amigo también se suscribe su perfil retenido:
     nombre y FOTO DE PERFIL siempre al día                              */
'use strict';

const Presence = {
  map: {},        /* uid -> {online, ts} */
  _hb: null,
  _stale: null,

  goOnline() {
    if (!Auth.me) return;
    Mqtt.publish(T.presence(Auth.me.uid), { online: true, ts: Date.now() }, { retain: true });
  },
  goOffline() {
    if (!Auth.me) return;
    Mqtt.publish(T.presence(Auth.me.uid), { online: false, ts: Date.now() }, { retain: true });
  },
  startTimers() {
    if (!this._hb) this._hb = setInterval(() => this.goOnline(), 25000);
    if (!this._stale) this._stale = setInterval(() => {
      if (typeof App !== 'undefined' && App.refreshPresenceUI) App.refreshPresenceUI();
    }, 15000);
  },
  /* se usa al CAMBIAR DE USUARIO: los latidos no deben pisar el puntero
     «moved» que queda retenido sobre la presencia antigua */
  stopTimers() {
    if (this._hb) { clearInterval(this._hb); this._hb = null; }
    if (this._stale) { clearInterval(this._stale); this._stale = null; }
  },

  watch(uid) {
    if (!uid || uid === (Auth.me && Auth.me.uid)) return;
    Mqtt.sub([T.presence(uid), T.profile(uid)]);
  },
  unwatch(uid) {
    if (!uid) return;
    Mqtt.unsub(T.presence(uid));
    Mqtt.unsub(T.profile(uid));
    delete this.map[uid];
  },

  update(uid, m) {
    if (!m) return;
    /* puntero «moved»: esa cuenta cambió de usuario → migrar el contacto
       (llega en vivo o retenido al reconectar; los no-amigos lo ignoran) */
    if (m.moved && m.moved !== uid && typeof Friends !== 'undefined' && Friends.onRename) {
      Friends.onRename(uid, m.moved, m.name);
      return;
    }
    if (typeof m.ts !== 'number') return;
    const cur = this.map[uid];
    if (cur && cur.ts >= m.ts && cur.online === !!m.online) return;
    this.map[uid] = { online: !!m.online, ts: m.ts };
    if (typeof App !== 'undefined' && App.refreshPresenceUI) App.refreshPresenceUI();
  },

  isOnline(uid) {
    const p = this.map[uid];
    return !!p && p.online && (Date.now() - p.ts) < 70000;
  },
  status(uid) { return this.isOnline(uid) ? 'en línea' : this.lastSeenTxt(uid); },
  lastSeenTxt(uid) {
    const p = this.map[uid];
    if (p && !p.online && p.ts && Date.now() - p.ts < 30 * 864e5) {
      return 'últ. vez ' + fmtDay(p.ts);
    }
    return 'desconectado';
  }
};
