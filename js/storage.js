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
  spamStats: (u) => `nexo_${u}_spamstats`
};

/* IndexedDB para blobs de imágenes (no satura localStorage) */
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
  }
};
