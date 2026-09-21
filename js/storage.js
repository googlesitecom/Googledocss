/* storage.js — localStorage (con ámbito por cuenta) + IndexedDB para imágenes */
'use strict';

const LS = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
    catch (e) { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('LS lleno', e); }
  },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

/* Claves — las de datos personales llevan ámbito de usuario */
const K = {
  session: 'nexo_session',
  prefs: 'nexo_prefs',
  friends: (u) => `nexo_${u}_friends`,
  pout: (u) => `nexo_${u}_pending_out`,
  hist: (u, f) => `nexo_${u}_hist_${f}`,
  unread: (u) => `nexo_${u}_unread`,
  notifs: (u) => `nexo_${u}_notifs`,
  spamStats: (u) => `nexo_${u}_spamstats`,
  groups: (u) => `nexo_${u}_groups`,
  avatars: (u) => `nexo_${u}_avatars`
};

/* IndexedDB para blobs (imágenes, audios, fondo personalizado) */
const IDB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      if (this.db) return resolve(this.db);
      const r = indexedDB.open('nexo_media', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('blobs'); };
      r.onsuccess = () => { this.db = r.result; resolve(this.db); };
      r.onerror = () => reject(r.error);
    });
  },
  put(key, blob) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('IDB no disponible'));
      const tx = this.db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  get(key) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('IDB no disponible'));
      const rq = this.db.transaction('blobs', 'readonly').objectStore('blobs').get(key);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => reject(rq.error);
    });
  },
  del(key) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('IDB no disponible'));
      const tx = this.db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
};

/* Avatares (fotos de perfil) — caché local por cuenta; la fuente de
   verdad es el campo `av` del perfil retenido en MQTT. */
const Avatars = {
  cache() { return Auth.me ? LS.get(K.avatars(Auth.me.uid), {}) : {}; },
  get(uid) { return this.cache()[uid] || null; },
  set(uid, dataURL) {
    if (!Auth.me) return;
    const c = LS.get(K.avatars(Auth.me.uid), {});
    c[uid] = { av: dataURL, ts: Date.now() };
    LS.set(K.avatars(Auth.me.uid), c);
  },
  remove(uid) {
    if (!Auth.me) return;
    const c = LS.get(K.avatars(Auth.me.uid), {});
    delete c[uid];
    LS.set(K.avatars(Auth.me.uid), c);
  },
  /* contenido interno para un div.avatar: <img> o iniciales */
  html(uid, name) {
    const a = this.get(uid);
    if (a && a.av) return `<img src="${esc(a.av)}" alt="">`;
    return esc(initials(name || uid));
  }
};
