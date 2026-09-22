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
  avatars: (u) => `nexo_${u}_avatars`,
  stickers: (u) => `nexo_${u}_stickers`
};

/* IndexedDB para blobs (imágenes, audios, fondo personalizado)
   v2: añade el store «kv» — datos clave/valor que también lee el
   Service Worker (p. ej. la lista de chats silenciados, para que el
   push NO suene en un chat silenciado aunque la app esté cerrada). */
const IDB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      if (this.db) return resolve(this.db);
      const r = indexedDB.open('nexo_media', 2);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('blobs')) r.result.createObjectStore('blobs');
        if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv');
      };
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
  },
  /* ---- clave/valor (compartido página + Service Worker) ---- */
  kvSet(key, value) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('IDB no disponible'));
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  kvGet(key) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('IDB no disponible'));
      const rq = this.db.transaction('kv', 'readonly').objectStore('kv').get(key);
      rq.onsuccess = () => resolve(rq.result === undefined ? null : rq.result);
      rq.onerror = () => reject(rq.error);
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

/* Fotos de GRUPO — caché local por cuenta; la fuente de verdad es el
   campo `av` del descriptor retenido del grupo (nexo/v1/group/<gid>). */
const GroupAvatars = {
  cache() { return LS.get(K.groups(Auth.me ? Auth.me.uid : '_') + '_av', {}); },
  save(c) { if (Auth.me) LS.set(K.groups(Auth.me.uid) + '_av', c); },
  get(gid) { const c = this.cache(); return (c[gid] && c[gid].av) || null; },
  set(gid, dataURL) {
    const c = this.cache();
    c[gid] = { av: dataURL, ts: Date.now() };
    this.save(c);
  },
  remove(gid) {
    const c = this.cache();
    delete c[gid];
    this.save(c);
  },
  /* contenido interno para el avatar de un grupo: <img> o icono de grupo */
  html(gid) {
    const a = this.get(gid);
    if (a) return `<img src="${esc(a)}" alt="">`;
    return `<span class="g-mark"><svg class="icon"><use href="#i-users"/></svg></span>`;
  }
};
