/* mqtt-service.js — backbone en tiempo real sobre broker público MQTT/WSS
   - Registro de cuentas y perfiles con mensajes retenidos (directorio global)
   - Presencia con LWT + heartbeat
   - Solicitudes de amistad retenidas (entrega aunque el otro esté desconectado)
   - Mensajes con tema único por mensaje (retained + expiración 7 días = bandeja offline)
   - Reconexión automática con re-suscripción y conmutador de broker de respaldo  */
'use strict';

const MQTT_URLS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt'
];

const NS = 'nexo/v1';
const T = {
  auth: (u) => `${NS}/auth/${u}`,
  profile: (u) => `${NS}/profile/${u}`,
  presence: (u) => `${NS}/presence/${u}`,
  freq: (to, from) => `${NS}/freq/${to}/${from}`,
  fresp: (to, from) => `${NS}/fresp/${to}/${from}`,
  dm: (to, from, id) => `${NS}/dm/${to}/${from}/${id}`,
  dmc: (to, from, id, i) => `${NS}/dm/${to}/${from}/${id}/${i}`,
  evt: (u) => `${NS}/evt/${u}`,
  /* grupos */
  group: (gid) => `${NS}/group/${gid}`,
  gm: (gid, from, id) => `${NS}/gm/${gid}/${from}/${id}`,
  gmc: (gid, from, id, i) => `${NS}/gm/${gid}/${from}/${id}/${i}`,
  gsys: (gid, from) => `${NS}/gm/${gid}/sys/${from}`,
  ginv: (u, gid) => `${NS}/ginv/${u}/${gid}`,
  /* estado RETENIDO de la llamada de grupo en curso (unirse tarde) */
  gcall: (gid) => `${NS}/gcall/${gid}`,
  /* REACCIONES con emoji: retenidas por mensaje (expiran a los 7 días)
     - DM: rx/<destinatario>/<autor de la reacción>/<id de mensaje>
     - Grupo: grx/<gid>/<autor de la reacción>/<id de mensaje>          */
  rx: (to, from, id) => `${NS}/rx/${to}/${from}/${id}`,
  grx: (gid, from, id) => `${NS}/grx/${gid}/${from}/${id}`,
  /* suscripción web push de cada usuario (notificaciones sin abrir la app) */
  psub: (u) => `${NS}/psub/${u}`
};

const Mqtt = {
  client: null,
  connected: false,
  uid: null,
  _subs: new Set(),
  _handlers: [],
  _onStatus: null,
  _onReady: null,
  _onReconnect: null,
  _readyFired: false,
  _urlIdx: 0,

  /* opts: {uid (null = anónimo), onReady, onMessage, onStatus, onReconnect} */
  connect(opts) {
    if (this.client) { try { this.client.end(true); } catch (e) {} }
    this.client = null;
    this.connected = false;
    this.uid = opts.uid || null;
    this._onReady = opts.onReady || null;
    this._onStatus = opts.onStatus || null;
    this._onReconnect = opts.onReconnect || null;
    this._handlers = [opts.onMessage].filter(Boolean);
    this._subs = new Set();
    this._readyFired = false;
    this._tryConnect();
  },

  _tryConnect() {
    const url = MQTT_URLS[this._urlIdx % MQTT_URLS.length];
    this._setStatus('connecting');
    const clientId = 'nx_' + (this.uid || 'anon') + '_' + Math.random().toString(36).slice(2, 10);

    const connOpts = {
      clientId,
      clean: true,
      protocolVersion: 5,
      keepalive: 25,
      reconnectPeriod: 3500,
      connectTimeout: 10000
    };
    /* LWT: si la conexión muere, el broker publica "offline" retenido */
    if (this.uid) {
      connOpts.will = {
        topic: T.presence(this.uid),
        payload: JSON.stringify({ online: false, ts: Date.now() }),
        retain: true,
        qos: 0
      };
    }

    let settled = false;
    const c = mqtt.connect(url, connOpts);
    this.client = c;

    const swap = () => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      try { c.end(true); } catch (e) {}
      this._urlIdx++;
      this._tryConnect();
    };
    const to = setTimeout(swap, 14000);

    c.on('connect', () => {
      settled = true;
      clearTimeout(to);
      this.connected = true;
      this._setStatus('online');
      if (!this._readyFired) {
        this._readyFired = true;
        if (this._onReady) this._onReady();
      } else {
        /* reconexión: re-suscribir todo y avisar */
        if (this._subs.size) {
          try { c.subscribe([...this._subs], { qos: 0 }); } catch (e) {}
        }
        if (this._onReconnect) this._onReconnect();
      }
    });

    c.on('close', () => {
      this.connected = false;
      this._setStatus('connecting');
    });

    c.on('error', (e) => {
      console.warn('[mqtt]', e && e.message);
      if (!settled) swap();
    });

    c.on('message', (topic, payload, packet) => {
      /* payload vacío = borrado de retenido → ignorar */
      if (!payload || !payload.length) return;
      const s = payload.toString();
      this._handlers.forEach((h) => {
        try { h(topic, s, packet); } catch (e) { console.error('[handler]', e); }
      });
    });
  },

  _setStatus(s) { if (this._onStatus) this._onStatus(s); },

  publish(topic, obj, opts = {}) {
    if (!this.client || !this.connected) return false;
    try {
      const payload = obj === '' ? '' : JSON.stringify(obj);
      const o = { qos: 0, retain: !!opts.retain };
      if (opts.expiry) o.properties = { messageExpiryInterval: opts.expiry };
      this.client.publish(topic, payload, o);
      return true;
    } catch (e) {
      console.warn('[publish]', e);
      return false;
    }
  },

  sub(topics) {
    const arr = Array.isArray(topics) ? topics : [topics];
    arr.forEach((t) => this._subs.add(t));
    if (this.connected && this.client) {
      try { this.client.subscribe(arr, { qos: 0 }); } catch (e) {}
    }
  },

  unsub(topic) {
    this._subs.delete(topic);
    if (this.connected && this.client) {
      try { this.client.unsubscribe(topic); } catch (e) {}
    }
  },

  end() {
    if (this.client) { try { this.client.end(true); } catch (e) {} }
    this.client = null;
    this.connected = false;
  },

  /* Espera un mensaje retenido (búsqueda de usuarios / verificación de cuenta).
     Si el tema ya estaba suscrito (p. ej. presencia/perfil de un amigo),
     NO se desuscribe al terminar: la suscripción activa se conserva. */
  fetchRetained(topic, timeout = 2600) {
    return new Promise((resolve) => {
      if (!this.client) return resolve(null);
      const wasSubscribed = this._subs.has(topic);
      let done = false;
      const handler = (t, s) => {
        if (t !== topic || done) return;
        let v = null;
        try { v = JSON.parse(s); } catch (e) { v = null; }
        finish(v);
      };
      const finish = (v) => {
        if (done) return;
        done = true;
        if (this.client) { try { this.client.removeListener('message', handler); } catch (e) {} }
        if (!wasSubscribed) this.unsub(topic);
        resolve(v);
      };
      this.client.on('message', handler);
      this.sub(topic);
      setTimeout(() => finish(null), timeout);
    });
  }
};
