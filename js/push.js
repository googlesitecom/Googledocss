/* push.js — NOTIFICACIONES SIN ABRIR LA APP (Web Push 100% cliente)
   Arquitectura sin servidor (GitHub Pages no ejecuta backend):
   1. sw.js (Service Worker) recibe los push del sistema operativo
      aunque la página esté cerrada y muestra la notificación.
   2. Cada usuario publica su suscripción Web Push (endpoint + claves)
      como mensaje retenido en MQTT: nexo/v1/psub/<uid>
   3. Cuando A envía un mensaje a B y B está desconectado, el navegador
      de A cifra la notificación (RFC 8291 aes128gcm con WebCrypto),
      firma la cabecera VAPID (RFC 8292, ES256) y hace POST directamente
      al endpoint del push service de B. El push service despierta el
      Service Worker de B → notificación del sistema.
   - Anti-spam: los remitentes con mensajes detectados como spam NO
     envían push (lo decide el llamador con Spam.check).
   - En iOS las notificaciones requieren instalar la app (PWA).        */
'use strict';

/* Par VAPID fijo de la aplicación (la pública es visible; la "privada"
   vive en el cliente porque aquí no hay servidor: es la identidad de
   la app ante los push services). */
const VAPID = {
  pub: 'BBUQRDKbw1nH4q3CkVMrOg8TcW0xsW0FftAW8I3FNx7pftrfLnusei0EjZ0A1d2ObDiYDPpOvyAFJm8zqDFEdFY',
  priv: '13u-bnqH9oFNnM0gccLGM6fnxYgM-wx_oMVxiAxreFY',
  x: 'FRBEMpvDWcfircKRUys6DxNxbTGxbQV-0BbwjcU3Huk',
  y: 'ftrfLnusei0EjZ0A1d2ObDiYDPpOvyAFJm8zqDFEdFY',
  subject: 'mailto:nexo.app@github.pages'
};

/* ---------- utilidades base64url ---------- */
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function bytesToB64url(bytes) {
  let bin = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function strBytes(s) { return new TextEncoder().encode(s); }
function cat(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/* ---------- HMAC-SHA256 (bloque de construcción de HKDF) ---------- */
async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

/* ---------- Cifrado del payload (RFC 8291, aes128gcm) ----------
   Esquema validado contra la librería de referencia web-push (http_ece):
   1. ikm            = ECDH(efímera, p256dh del receptor)
   2. webpushSecret  = HMAC(HMAC(auth, ikm), "WebPush: info\0"||recvPub||ephPub||0x01)
   3. prk            = HMAC(salt_aleatorio_del_header, webpushSecret)
   4. cek / nonce    = HMAC(prk, "Content-Encoding: aes128gcm\0"||0x01) / "…nonce\0"||0x01
   5. AES-128-GCM(cek, nonce, plaintext||0x02)                          */
async function encryptPayload(sub, plaintext) {
  const authSecret = b64urlToBytes(sub.keys.auth);
  const recvRaw = b64urlToBytes(sub.keys.p256dh);
  const serverPub = await crypto.subtle.importKey(
    'raw', recvRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPub }, eph.privateKey, 256));
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  const prk0 = await hmac(authSecret, ikm);
  const webpushSecret = (await hmac(prk0, cat(strBytes('WebPush: info\0'), recvRaw, ephRaw, new Uint8Array([1])))).slice(0, 32);

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const prk = await hmac(salt, webpushSecret);

  const cek = (await hmac(prk, cat(strBytes('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(strBytes('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  /* contenido: texto || 0x02 (delimitador de registro final) */
  const data = cat(strBytes(plaintext), new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, data));

  /* cabecera aes128gcm: salt(16) | rs(4 BE = 4096) | idlen(1) | llave efímera(65) */
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([ephRaw.length]), ephRaw, ciphertext);
}

/* ---------- JWT VAPID (RFC 8292, ES256) ---------- */
async function vapidAuthHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(strBytes(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(strBytes(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID.subject
  })));
  const jwk = { kty: 'EC', crv: 'P-256', x: VAPID.x, y: VAPID.y, d: VAPID.priv };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, strBytes(header + '.' + payload)));
  return `vapid t=${header}.${payload}.${bytesToB64url(sig)}, k=${VAPID.pub}`;
}

/* ==================== módulo ==================== */
const Push = {
  swReg: null,
  sub: null,          /* mi suscripción actual */
  state: 'off',       /* off | pending | on | denied | unavailable */
  _subCache: new Map(), /* uid -> {sub, ts} suscripciones de otros */
  _cooldown: new Map(),  /* uid -> ts del último push */
  COOLDOWN_MS: 25000,

  /* ---------- inicialización (tras login) ---------- */
  async init() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { this.state = 'unavailable'; return; }
    if (!window.isSecureContext) { this.state = 'unavailable'; return; }
    try {
      this.swReg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await navigator.serviceWorker.ready;
      this.sub = await this.swReg.pushManager.getSubscription();
      if (this.sub) {
        this.state = 'on';
        this.publishSub();
      } else if (('Notification' in window) && Notification.permission === 'granted') {
        /* el permiso ya fue concedido pero se perdió la suscripción
           (p. ej. el push service la rotó): re-suscribir sin gesto */
        try {
          const key = b64urlToBytes(VAPID.pub);
          this.sub = await this.swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          this.state = 'on';
          this.publishSub();
        } catch (e) { console.warn('[push] resubscribe', e); }
      }
    } catch (e) {
      console.warn('[push] init', e);
      this.state = 'unavailable';
    }
  },

  /* ---------- activación con gesto del usuario ---------- */
  async enable() {
    if (this.state === 'unavailable') throw new Error('Este navegador no soporta notificaciones en segundo plano.');
    if (!('Notification' in window)) throw new Error('Tu navegador no soporta notificaciones.');
    let perm = Notification.permission;
    if (perm !== 'granted') {
      perm = await Notification.requestPermission();
    }
    if (perm !== 'granted') { this.state = 'denied'; throw new Error('Permiso de notificaciones denegado.'); }

    this.state = 'pending';
    try {
      if (!this.swReg) this.swReg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await navigator.serviceWorker.ready;
      const key = b64urlToBytes(VAPID.pub);
      this.sub = await this.swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (e) {
      console.warn('[push] subscribe', e);
      this.state = 'unavailable';
      throw new Error('No se pudo registrar el push: ' + (e && e.message ? e.message : 'error'));
    }
    this.state = 'on';
    this.publishSub();
    return true;
  },

  /* ---------- publicar mi suscripción al directorio MQTT ---------- */
  publishSub() {
    if (!this.sub || !Auth.me || !Mqtt.connected) return;
    const s = this.sub.toJSON ? this.sub.toJSON() : this.sub;
    Mqtt.publish(T.psub(Auth.me.uid), {
      endpoint: s.endpoint,
      keys: s.keys,
      ts: Date.now()
    }, { retain: true, expiry: 2592000 }); /* refrescada al reconectar; caduca a 30 días */
  },

  /* ---------- suscripción de otro usuario (con caché) ---------- */
  async getSub(uid) {
    const c = this._subCache.get(uid);
    if (c && Date.now() - c.ts < 10 * 60000) return c.sub;
    const sub = await Mqtt.fetchRetained(T.psub(uid), 1800);
    if (sub && sub.endpoint && sub.keys && sub.keys.p256dh && sub.keys.auth) {
      this._subCache.set(uid, { sub, ts: Date.now() });
      return sub;
    }
    this._subCache.set(uid, { sub: null, ts: Date.now() });
    return null;
  },

  /* ---------- enviar una notificación push a un uid ----------
     Devuelve true si se entregó al push service.
     opts.force: ignora el enfriamiento (prueba desde Ajustes). */
  async notify(uid, title, body, route = {}, opts = {}) {
    try {
      if (!uid) return false;

      const last = this._cooldown.get(uid) || 0;
      if (!opts.force && Date.now() - last < this.COOLDOWN_MS) return false;

      const sub = await this.getSub(uid);
      if (!sub) return false;

      /* tag por chat: agrupa las notificaciones del mismo chat y evita
         duplicados visuales con la notificación de la propia página */
      const tag = route.chat ? ('nexo-msg-' + route.chat) : (route.friends ? 'nexo-sys-friends' : 'nexo-sys');
      const payload = JSON.stringify({ title: truncate(title, 90), body: truncate(body, 140), tag, route });
      if (strBytes(payload).length > 3000) throw new Error('payload excesivo');

      const bodyBytes = await encryptPayload(sub, payload);
      const authz = await vapidAuthHeader(sub.endpoint);
      const headers = {
        'TTL': '86400',
        'Urgency': 'high',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Authorization': authz
      };

      let ok = false;
      try {
        const r = await fetch(sub.endpoint, { method: 'POST', headers, body: bodyBytes });
        ok = r.status >= 200 && r.status < 300;
        if (!ok) console.warn('[push] endpoint respondió', r.status);
      } catch (e) {
        /* CORS o red: reintento por proxy público (el contenido ya va cifrado) */
        try {
          const r2 = await fetch('https://corsproxy.io/?url=' + encodeURIComponent(sub.endpoint), {
            method: 'POST', headers, body: bodyBytes
          });
          ok = r2.status >= 200 && r2.status < 300;
        } catch (e2) {
          console.warn('[push] entrega fallida', e2);
        }
      }
      if (ok || opts.force) this._cooldown.set(uid, Date.now());
      return ok;
    } catch (e) {
      console.warn('[push] notify', e);
      return false;
    }
  },

  /* ---------- helpers de estado ---------- */
  permission() { return ('Notification' in window) ? Notification.permission : 'unsupported'; },
  isOn() { return !!this.sub && this.permission() === 'granted'; }
};
