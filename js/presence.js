/* presence.js — presencia en línea real
   - Publica "online" retenido al conectar + heartbeat cada 25 s
   - LWT del broker publica "offline" si la conexión muere
   - Un.online se considera vigente 70 s (por si un latido se pierde)  */
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

  watch(uid) {
    if (!uid || uid === (Auth.me && Auth.me.uid)) return;
    Mqtt.sub(T.presence(uid));
  },
  unwatch(uid) {
    if (!uid) return;
    Mqtt.unsub(T.presence(uid));
    delete this.map[uid];
  },

  update(uid, m) {
    if (!m || typeof m.ts !== 'number') return;
    const cur = this.map[uid];
    if (cur && cur.ts >= m.ts && cur.online === !!m.online) return;
    this.map[uid] = { online: !!m.online, ts: m.ts };
    if (typeof App !== 'undefined' && App.refreshPresenceUI) App.refreshPresenceUI();
  },

  isOnline(uid) {
    const p = this.map[uid];
    return !!p && p.online && (Date.now() - p.ts) < 70000;
  },
  status(uid) { return this.isOnline(uid) ? 'en línea' : 'desconectado'; }
};
