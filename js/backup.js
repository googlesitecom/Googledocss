/* backup.js — v10: copia de seguridad en la nube (todo el dispositivo)
   PROBLEMA: los chats y ajustes vivían solo en el localStorage del
   dispositivo → al cerrar sesión o entrar desde otro móvil/PC se perdían.

   SOLUCIÓN: la propia red MQTT del broker público actúa de almacén cifrado:
     - DATOS (chats, amigos, grupos, stickers, no leídos, ajustes…):
       JSON → AES-GCM (clave derivada de la CONTRASEÑA con PBKDF2 y sal
       propia) → base64 → chunks retenidos en bk/<uid>/d/<i> + manifiesto
       bk/<uid>/dm. Sin expiración: la copia vive mientras la cuenta.
     - MULTIMEDIA (fotos, stickers, audios, fondo propio): cada blob se
       cifra aparte y se publica en bk/<uid>/f/<id>/<i>; el manifiesto
       bk/<uid>/fm lista los ids → publicación INCREMENTAL (solo lo nuevo)
       y limpieza de lo que ya no existe.
     - NADIE puede leer la copia sin la contraseña (ni el broker): solo
       viaja texto cifrado; la sal PBKDF2 es pública por diseño (como en
       el registro de cuentas) pero la clave nunca sale del dispositivo.

   FLUJOS:
     · Login / registro → Backup.afterLogin(pwd): restaura los datos de
       la nube (fusión aditiva: lo local manda, se añade lo que falte) y
       prepara la clave; la multimedia se restaura en segundo plano.
     · Cualquier cambio local (LS.set) → auto-respaldo diferido (45 s).
     · Cerrar sesión → respaldo completo (datos + multimedia incremental)
       ANTES de recargar; los datos locales se CONSERVAN en el dispositivo.
     · Cambiar de usuario → la copia migra al nuevo uid (re-publicación
       de los chunks tal cual, sin re-cifrar) y se limpia la antigua.
     · La clave se cachea en nexo_<uid>_bk solo durante la sesión (se
       borra al cerrar sesión) → el auto-respaldo sobrevive a recargas.  */
'use strict';

const Backup = {
  CHUNK: 48000,          /* caracteres base64 por chunk (igual que los DM) */
  MAX_MEDIA: 200,        /* nº máximo de blobs multimedia en la copia */
  MAX_MEDIA_BYTES: 6 * 1024 * 1024,
  AUTO_DELAY: 45000,     /* auto-respaldo 45 s después del último cambio */
  AUTO_MIN_GAP: 30000,   /* y nunca más de una vez cada 30 s */

  _key: null,            /* CryptoKey AES-GCM en memoria */
  _salt: null,
  _iters: null,
  _timer: null,
  _lastAuto: 0,
  _busy: false,
  _restoring: false,
  _needsInit: false,     /* copia por crear en cuanto la conexión con identidad esté viva */

  keyLS: (u) => `nexo_${u}_bk`,
  metaLS: (u) => `nexo_${u}_bkmeta`,

  /* ================== claves / estado ================== */

  hasKey() { return !!(Auth.me && localStorage.getItem(this.keyLS(Auth.me.uid))); },

  async _ensureKey() {
    if (this._key) return this._key;
    if (!Auth.me) return null;
    const raw = localStorage.getItem(this.keyLS(Auth.me.uid));
    if (!raw) return null;
    try { this._key = await importKeyB64(raw); }
    catch (e) { this._key = null; }
    return this._key;
  },

  _storeKey() {
    if (!Auth.me || !this._key) return;
    exportKeyB64(this._key).then((b64) => {
      try { localStorage.setItem(this.keyLS(Auth.me.uid), b64); } catch (e) {}
    }).catch(() => {});
  },

  wipeKey() {
    if (!Auth.me) return;
    try { localStorage.removeItem(this.keyLS(Auth.me.uid)); } catch (e) {}
    this._key = null;
  },

  _getMeta() {
    if (!Auth.me) return null;
    try { return JSON.parse(localStorage.getItem(this.metaLS(Auth.me.uid)) || 'null'); } catch (e) { return null; }
  },
  _setMeta(patch) {
    if (!Auth.me) return;
    try {
      const m = Object.assign(this._getMeta() || {}, patch);
      localStorage.setItem(this.metaLS(Auth.me.uid), JSON.stringify(m));
    } catch (e) {}
  },

  /* sal PBKDF2 estable de la copia (cacheada local o leída del manifiesto) */
  async _saltInfo() {
    if (this._salt) return { salt: this._salt, iters: this._iters || PBKDF2_ITERS };
    const m = this._getMeta();
    if (m && m.salt) { this._salt = m.salt; this._iters = m.iters || PBKDF2_ITERS; return { salt: this._salt, iters: this._iters }; }
    const dm = await Mqtt.fetchRetained(T.bkdm(Auth.me.uid), 2600);
    if (dm && dm.salt) {
      this._salt = dm.salt; this._iters = dm.iters || PBKDF2_ITERS;
      this._setMeta({ salt: this._salt, iters: this._iters });
      return { salt: this._salt, iters: this._iters };
    }
    return null;
  },

  enabled() { return typeof Settings === 'undefined' || Settings.bk !== false; },

  /* ================== instantánea de datos ================== */

  snapshotData() {
    const u = Auth.me.uid;
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === K.prefs) { ls[k] = localStorage.getItem(k); continue; }
      if (!k.startsWith(`nexo_${u}_`)) continue;
      /* nunca sale: la clave AES, su caché, la sesión (va aparte) ni los
         cachés de avatares (se auto-reparan desde el broker al conectar) */
      if (k === this.keyLS(u) || k === this.metaLS(u)) continue;
      if (k === `nexo_${u}_avatars` || k === `nexo_${u}_groups_av`) continue;
      ls[k] = localStorage.getItem(k);
    }
    return { v: 1, t: Date.now(), uid: u, ls };
  },

  /* ================== publicación de DATOS ================== */

  async publishData() {
    const u = Auth.me.uid;
    await this._ensureKey();
    const si = await this._saltInfo();
    if (!this._key || !si) return 0;
    const data = this.snapshotData();
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    const { iv, ct } = await aesEncryptBytes(this._key, bytes);
    const ctB64 = bytesToB64(ct);
    const n = Math.ceil(ctB64.length / this.CHUNK);
    const sum = (await sha256Hex(ct)).slice(0, 16);
    const prev = this._getMeta();
    /* limpiar chunks sobrantes de una copia anterior más grande */
    if (prev && prev.chunks > n) {
      for (let i = n; i < prev.chunks; i++) await Mqtt.publishQ(T.bkd(u, i), '', { retain: true }, 2500);
    }
    for (let i = 0; i < n; i++) {
      await Mqtt.publishQ(T.bkd(u, i), { i, d: ctB64.substr(i * this.CHUNK, this.CHUNK) }, { retain: true });
    }
    await Mqtt.publishQ(T.bkdm(u), {
      v: 1, alg: 'A256GCM', kdf: 'PBKDF2', hash: 'SHA-256',
      iters: si.iters, salt: si.salt, iv: bytesToB64(iv),
      n, t: data.t, sum
    }, { retain: true });
    this._setMeta({ t: data.t, bytes: ctB64.length, chunks: n, salt: si.salt, iters: si.iters });
    return ctB64.length;
  },

  /* ================== multimedia (incremental) ================== */

  /* blobs a respaldar: medios de los historiales (los más recientes
     primero), la galería de stickers y el fondo personalizado */
  async _mediaWanted() {
    const u = Auth.me.uid;
    const found = new Map(); /* idKey -> ts */
    const histPrefix = `nexo_${u}_hist_`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith(histPrefix)) continue;
      let h = null;
      try { h = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { continue; }
      if (!Array.isArray(h)) continue;
      for (const m of h) {
        if (!m || !m.id || m.deleted) continue;
        if (m.t === 'img' || m.t === 'stk' || m.t === 'voice') {
          const ts = m.ts || 0;
          if (!found.has(m.id) || found.get(m.id) < ts) found.set(m.id, ts);
        }
      }
    }
    /* stickers de mi galería (los blobs viven bajo stk_<id>) */
    let stks = [];
    try { stks = LS.get(K.stickers(u), []); } catch (e) {}
    stks.forEach((s) => { if (s && s.id) found.set('stk_' + s.id, s.ts || 0); });
    /* fondo personalizado (siempre) */
    const wp = await IDB.get('wp_custom').catch(() => null);
    if (wp) found.set('wp_custom', Date.now());

    /* orden: lo más reciente primero → el tope corta por lo más viejo */
    const list = [...found.entries()].map(([k, ts]) => ({ k, ts })).sort((a, b) => b.ts - a.ts);
    const out = [];
    let total = 0;
    for (const w of list) {
      if (out.length >= this.MAX_MEDIA || total >= this.MAX_MEDIA_BYTES) break;
      out.push(w);
    }
    return out;
  },

  async _loadFM() {
    const u = Auth.me.uid;
    let fm = null;
    try { fm = JSON.parse(localStorage.getItem(this.metaLS(u)) || 'null'); } catch (e) {}
    if (fm && fm.fm && fm.fm.ids) return fm.fm;
    const remote = await Mqtt.fetchRetained(T.bkfm(u), 2600);
    if (remote && remote.ids) {
      this._setMeta({ fm: remote });
      return remote;
    }
    return { v: 1, t: 0, ids: {} };
  },
  _saveFM(fm) { this._setMeta({ fm }); },

  /* publica SOLO los blobs nuevos y retira los que ya no existen localmente
     (los publicados por OTROS dispositivos se conserven siempre)          */
  async publishMedia(onProgress) {
    const u = Auth.me.uid;
    await this._ensureKey();
    if (!this._key) return null;

    const myFM = await this._loadFM();          /* lo que YO puse en la nube */
    const myIds = myFM.ids || {};
    const brokerFM = (await Mqtt.fetchRetained(T.bkfm(u), 2600)) || { v: 1, t: 0, ids: {} };
    const brokerIds = brokerFM.ids || {};

    const wanted = await this._mediaWanted();
    const wantMap = new Map(wanted.map((w) => [w.k, w]));

    const ids = {};                              /* manifiesto resultante */
    let published = 0, removed = 0, outBytes = 0;

    for (const w of wanted) {
      const prev = myIds[w.k] || brokerIds[w.k];
      if (prev && prev.n) { ids[w.k] = prev; outBytes += prev.s || 0; continue; }
      const blob = await IDB.get(w.k).catch(() => null);
      if (!blob) continue;
      try {
        const { iv, ct } = await aesEncryptBytes(this._key, new Uint8Array(await blob.arrayBuffer()));
        const ctB64 = bytesToB64(ct);
        const n = Math.ceil(ctB64.length / this.CHUNK);
        for (let i = 0; i < n; i++) {
          await Mqtt.publishQ(T.bkf(u, w.k, i), { i, d: ctB64.substr(i * this.CHUNK, this.CHUNK) }, { retain: true });
        }
        ids[w.k] = { n, iv: bytesToB64(iv), mt: blob.type || '', s: blob.size };
        outBytes += blob.size;
        published++;
        onProgress && onProgress(published, wanted.length);
      } catch (e) { console.warn('bk media put', w.k, e); }
    }

    /* retirar SOLO lo que yo subí y ya no existe localmente */
    for (const k of Object.keys(myIds)) {
      if (wantMap.has(k)) continue;
      for (let i = 0; i < (myIds[k].n || 1); i++) await Mqtt.publishQ(T.bkf(u, k, i), '', { retain: true }, 2500);
      removed++;
    }
    /* conservar lo que subieron otros dispositivos */
    for (const k of Object.keys(brokerIds)) {
      if (!ids[k] && !myIds[k]) ids[k] = brokerIds[k];
    }

    const fm = { v: 1, t: Date.now(), ids };
    await Mqtt.publishQ(T.bkfm(u), fm, { retain: true });
    this._saveFM(fm);
    this._setMeta({ media: Object.keys(ids).length, mediaBytes: outBytes });
    return { published, removed, count: Object.keys(ids).length, bytes: outBytes };
  },

  /* ================== restauración ================== */

  _assembleData(map, dm) {
    if (!map || !dm || !dm.n) return null;
    let ctB64 = '';
    for (let i = 0; i < dm.n; i++) {
      const raw = map.get(T.bkd(Auth.me.uid, i));
      if (!raw) return null;
      try { ctB64 += JSON.parse(raw).d || ''; } catch (e) { return null; }
    }
    return ctB64 || null;
  },

  async _decryptJSON(key, ivB64, ctB64) {
    const bytes = await aesDecryptBytes(key, ivB64, b64ToBytes(ctB64));
    return JSON.parse(new TextDecoder().decode(bytes));
  },

  /* fusión aditiva: lo que ya existe localmente manda; se añade lo que
     falte; los historiales se fusionan por id de mensaje (unión ordenada) */
  mergeData(data) {
    if (!data || !data.ls || !Auth.me) return { keys: 0, msgs: 0 };
    const u = Auth.me.uid;
    this._restoring = true;
    let appliedKeys = 0, addedMsgs = 0;
    try {
      for (const [k, raw] of Object.entries(data.ls)) {
        /* validar ámbito: solo mis claves o las preferencias globales */
        const mine = k.startsWith(`nexo_${u}_`) && k !== this.keyLS(u) && k !== this.metaLS(u);
        if (k !== K.prefs && !mine) continue;
        let val;
        try { val = JSON.parse(raw); } catch (e) { continue; }
        const cur = localStorage.getItem(k);
        if (cur == null) {
          try { localStorage.setItem(k, raw); } catch (e) { continue; }
          appliedKeys++;
          if (k.startsWith(`nexo_${u}_hist_`) && Array.isArray(val)) addedMsgs += val.length;
          continue;
        }
        let curVal;
        try { curVal = JSON.parse(cur); } catch (e) { continue; }

        /* preferencias: añadir las que falten (la local manda) */
        if (k === K.prefs) {
          if (val && typeof val === 'object') {
            const m = Object.assign({}, val, curVal);
            try { localStorage.setItem(k, JSON.stringify(m)); } catch (e) {}
          }
          continue;
        }

        /* historiales: unión por id de mensaje, cronológica, tope 400 */
        if (k.startsWith(`nexo_${u}_hist_`)) {
          if (Array.isArray(val) && Array.isArray(curVal) && val.length) {
            const byId = new Map();
            for (const m of curVal) if (m && m.id) byId.set(m.id, m);      /* local manda */
            const before = byId.size;
            for (const m of val) if (m && m.id && !byId.has(m.id)) byId.set(m.id, m);
            addedMsgs += byId.size - before;
            let merged = [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
            if (merged.length > 400) merged = merged.slice(merged.length - 400);
            try { localStorage.setItem(k, JSON.stringify(merged)); } catch (e) {}
          }
          continue;
        }

        /* listas (amigos, grupos, stickers, notifs, salidas): unión por
           uid / id / gid — las locales mandan */
        if (Array.isArray(val) && Array.isArray(curVal)) {
          const keyOf = (e) => (e && typeof e === 'object') ? (e.uid || e.id || e.gid || null) : e;
          const seen = new Set(curVal.map(keyOf).filter((x) => x !== null && x !== undefined));
          const extra = val.filter((e) => { const kk = keyOf(e); return kk === null || kk === undefined || !seen.has(kk); });
          if (extra.length) {
            try { localStorage.setItem(k, JSON.stringify([...curVal, ...extra])); } catch (e2) {}
          }
          continue;
        }

        /* objetos (no leídos, anti-spam…): rellenar claves que falten */
        if (val && typeof val === 'object' && curVal && typeof curVal === 'object'
            && !Array.isArray(val) && !Array.isArray(curVal)) {
          const m = Object.assign({}, curVal);
          let ch = false;
          for (const kk of Object.keys(val)) { if (!(kk in m)) { m[kk] = val[kk]; ch = true; } }
          if (ch) { try { localStorage.setItem(k, JSON.stringify(m)); } catch (e) {} }
          continue;
        }
        /* escalares: la versión local manda */
      }
    } finally { this._restoring = false; }
    return { keys: appliedKeys, msgs: addedMsgs };
  },

  /* tras restaurar: recargar preferencias y reflejarlo en la UI */
  refreshUI() {
    try {
      const p = LS.get(K.prefs, {});
      for (const k of Object.keys(p)) Settings[k] = p[k];
      /* invalidar el caché de historiales en memoria: los datos restaurados
         viven en localStorage y hist() no debe devolver copias viejas */
      if (typeof Chat !== 'undefined' && Chat._cache) Chat._cache = {};
      if (typeof App !== 'undefined') {
        App.initTheme();
        App.setFocus(Settings.focus);
        App.renderAll();
        App.updateTitle();
      }
      if (typeof Theme !== 'undefined' && Theme.apply) Theme.apply();
      if (typeof Notify !== 'undefined') Notify.load();
      if (typeof Chat !== 'undefined' && Chat.syncMuted) Chat.syncMuted();
    } catch (e) { console.warn('bk refreshUI', e); }
  },

  /* ---- tras el LOGIN: restaurar datos de la nube (o crear la copia) ---- */
  async afterLogin(pwd, onPhase) {
    if (!Auth.me || !pwd) return null;
    const u = Auth.me.uid;
    onPhase && onPhase('copia');
    const dm = await Mqtt.fetchRetained(T.bkdm(u), 2800);
    if (!dm || !dm.salt) {
      /* cuenta sin copia (nueva, o creada antes de v10): crearla en cuanto
         la conexión con identidad esté viva (initIfNeeded tras conectar) */
      this._salt = randomHex(16);
      this._iters = PBKDF2_ITERS;
      this._key = await deriveBackupKey(pwd, this._salt, this._iters);
      this._storeKey();
      this._setMeta({ salt: this._salt, iters: this._iters });
      this._needsInit = true;
      return { created: true, restored: null };
    }
    this._salt = dm.salt;
    this._iters = dm.iters || PBKDF2_ITERS;
    this._key = await deriveBackupKey(pwd, this._salt, this._iters);
    this._storeKey();
    this._setMeta({ salt: this._salt, iters: this._iters });

    onPhase && onPhase('restaurar');
    let restored = null;
    try {
      const map = await Mqtt.collectRetained(`${NS}/bk/${u}/d/#`, 8000, 700);
      const ctB64 = this._assembleData(map, dm);
      if (ctB64) {
        const data = await this._decryptJSON(this._key, dm.iv, ctB64);
        restored = this.mergeData(data);
        restored.cloudT = dm.t || 0;
      }
    } catch (e) { console.warn('bk restore', e); restored = null; }
    return { created: false, restored };
  },

  /* ---- tras el REGISTRO: preparar la clave; la copia se publica en
         cuanto la conexión con identidad esté viva (initIfNeeded) para
         no perder chunks al sustituir la conexión anónima ---- */
  async afterRegister(pwd) {
    if (!Auth.me || !pwd) return null;
    this._salt = randomHex(16);
    this._iters = PBKDF2_ITERS;
    this._key = await deriveBackupKey(pwd, this._salt, this._iters);
    this._storeKey();
    this._setMeta({ salt: this._salt, iters: this._iters });
    this._needsInit = true;
    return true;
  },

  /* ---- publicar la copia inicial si estaba pendiente (registro o
         cuenta anterior a v10): se llama tras startAppConnection ---- */
  async initIfNeeded() {
    if (!this._needsInit || !Auth.me) return false;
    this._needsInit = false;
    if (!this.enabled()) return false;
    await Mqtt.waitConnected(10000);
    if (!Mqtt.connected) { this._needsInit = true; return false; }
    try {
      await this._ensureKey();
      const bytes = await this.publishData();
      return bytes > 0;
    } catch (e) { console.warn('bk init', e); return false; }
  },

  /* ---- clave a partir de la contraseña (respaldo manual sin sesión
         con clave cacheada, p. ej. tras actualizar desde v9) ---- */
  async keyFromPassword(pwd) {
    if (!Auth.me || !pwd) return null;
    let si = await this._saltInfo();
    if (!si) {
      si = { salt: randomHex(16), iters: PBKDF2_ITERS };
      this._setMeta({ salt: si.salt, iters: si.iters });
    }
    this._salt = si.salt;
    this._iters = si.iters;
    this._key = await deriveBackupKey(pwd, this._salt, this._iters);
    this._storeKey();
    return this._key;
  },

  /* ---- multimedia: traer los blobs que falten en este dispositivo ---- */
  async restoreMedia(onProgress) {
    if (!Auth.me) return 0;
    await this._ensureKey();
    if (!this._key) return 0;
    const u = Auth.me.uid;
    /* la restauración de multimedia ocurre tras startAppConnection:
       esperar a que la conexión con identidad esté viva */
    if (typeof Mqtt.waitConnected === 'function') await Mqtt.waitConnected(8000);
    if (!Mqtt.connected) return 0;
    const fm = await Mqtt.fetchRetained(T.bkfm(u), 2800);
    if (!fm || !fm.ids || !Object.keys(fm.ids).length) return 0;
    this._saveFM(fm);
    const entries = Object.entries(fm.ids);
    const missing = [];
    for (const [k] of entries) {
      const has = await IDB.get(k).then((b) => !!b).catch(() => false);
      if (!has) missing.push(k);
    }
    if (!missing.length) return 0;
    const map = await Mqtt.collectRetained(`${NS}/bk/${u}/f/#`, 12000, 900);
    if (!map || !map.size) return 0;
    let done = 0;
    for (const k of missing) {
      const meta = fm.ids[k];
      if (!meta || !meta.n || !meta.iv) continue;
      let ctB64 = '';
      let bad = false;
      for (let i = 0; i < meta.n; i++) {
        const raw = map.get(T.bkf(u, k, i));
        if (!raw) { bad = true; break; }
        try { ctB64 += JSON.parse(raw).d || ''; } catch (e) { bad = true; break; }
      }
      if (bad || !ctB64) continue;
      try {
        const bytes = await aesDecryptBytes(this._key, meta.iv, b64ToBytes(ctB64));
        await IDB.put(k, new Blob([bytes], { type: meta.mt || 'application/octet-stream' }));
        done++;
        onProgress && onProgress(done, missing.length);
      } catch (e) { console.warn('bk media restore', k, e); }
    }
    return done;
  },

  /* ---- restauración manual desde Ajustes (pide la contraseña) ---- */
  async restoreNow(pwd) {
    if (!Auth.me || !pwd) throw new Error('No hay sesión activa.');
    const u = Auth.me.uid;
    const dm = await Mqtt.fetchRetained(T.bkdm(u), 2800);
    if (!dm || !dm.salt) throw new Error('No hay copia de seguridad en la nube para esta cuenta.');
    const key = await deriveBackupKey(pwd, dm.salt, dm.iters || PBKDF2_ITERS);
    const map = await Mqtt.collectRetained(`${NS}/bk/${u}/d/#`, 8000, 700);
    const ctB64 = this._assembleData(map, dm);
    if (!ctB64) throw new Error('La copia de la nube está incompleta (¿conexión?). Inténtalo de nuevo.');
    let data;
    try { data = await this._decryptJSON(key, dm.iv, ctB64); }
    catch (e) { throw new Error('No se pudo descifrar la copia con esa contraseña.'); }
    const restored = this.mergeData(data);
    this._key = key;
    this._salt = dm.salt;
    this._iters = dm.iters || PBKDF2_ITERS;
    this._storeKey();
    this._setMeta({ salt: this._salt, iters: this._iters });
    const media = await this.restoreMedia().catch(() => 0);
    return { restored, media };
  },

  /* ================== respaldo completo ================== */

  async flush(opts = {}) {
    if (!Auth.me || !Mqtt.connected) return null;
    await this._ensureKey();
    const si = await this._saltInfo();
    if (!this._key || !si) return null;
    this._busy = true;
    try {
      const bytes = await this.publishData();
      let media = null;
      if (opts.media && (typeof Settings === 'undefined' || Settings.bkMedia !== false)) {
        media = await this.publishMedia(opts.onProgress);
      }
      return { bytes, media };
    } finally { this._busy = false; }
  },

  /* ================== auto-respaldo ================== */

  onLocalWrite(k) {
    try {
      if (this._restoring || this._busy || !Auth.me) return;
      if (!this.enabled()) return;
      const u = Auth.me.uid;
      /* ignorar: la propia clave/caché del backup, la sesión y los cachés
         de avatares (se auto-reparan desde el broker) */
      if (k === this.keyLS(u) || k === this.metaLS(u) || k === K.session) return;
      if (k === `nexo_${u}_avatars` || k === `nexo_${u}_groups_av`) return;
      if (k !== K.prefs && !k.startsWith(`nexo_${u}_`)) return;
      if (!localStorage.getItem(this.keyLS(u))) return; /* sin clave no hay cifrado */
      this.schedule();
    } catch (e) {}
  },

  schedule() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._runAuto();
    }, this.AUTO_DELAY);
  },

  async _runAuto() {
    if (this._busy || !Mqtt.connected || !this.enabled()) return;
    if (!(await this._ensureKey())) return;
    const now = Date.now();
    if (now - this._lastAuto < this.AUTO_MIN_GAP) { this.schedule(); return; }
    this._lastAuto = now;
    try { await this.flush({ media: false }); }
    catch (e) { console.warn('bk auto', e); }
  },

  /* ================== migración al cambiar de usuario ================== */

  /* re-publica los chunks TAL CUAL (ya están cifrados) bajo el nuevo uid
     y limpia los antiguos; la clave no cambia (la contraseña es la misma) */
  async migrateUser(old, nu) {
    const oldPrefix = `${NS}/bk/${old}/`;
    const map = await Mqtt.collectRetained(`${oldPrefix}#`, 9000, 800);
    this._renameLocalKeys(old, nu);
    if (!map || !map.size) return false;
    const newPrefix = `${NS}/bk/${nu}/`;
    let count = 0;
    for (const [t, payload] of map.entries()) {
      const suffix = t.slice(oldPrefix.length);
      if (!suffix) continue;
      await Mqtt.publishQ(newPrefix + suffix, payload, { retain: true });
      await Mqtt.publishQ(t, '', { retain: true }, 2500);
      if (++count % 5 === 0) await sleep(25);
    }
    /* el uid antiguo queda libre también para copias */
    return true;
  },

  _renameLocalKeys(old, nu) {
    [['bk'], ['bkmeta']].forEach(([sf]) => {
      const k = `nexo_${old}_${sf}`;
      const v = localStorage.getItem(k);
      if (v != null) { localStorage.setItem(`nexo_${nu}_${sf}`, v); localStorage.removeItem(k); }
    });
  },

  /* ================== borrar la copia de la nube ================== */

  async wipeCloud() {
    if (!Auth.me) return 0;
    const u = Auth.me.uid;
    const map = await Mqtt.collectRetained(`${NS}/bk/${u}/#`, 9000, 800);
    const list = map ? [...map.keys()] : [];
    for (const t of list) await Mqtt.publishQ(t, '', { retain: true }, 2500);
    this.wipeKey();
    try { localStorage.removeItem(this.metaLS(u)); } catch (e) {}
    this._salt = null;
    this._saveFMDone();
    return list.length;
  },
  _saveFMDone() { this._setMeta({ fm: { v: 1, t: 0, ids: {} }, t: 0, bytes: 0, chunks: 0, media: 0 }); },

  /* ================== estado para Ajustes ================== */

  status() {
    const st = { on: this.enabled(), hasKey: false, t: 0, bytes: 0, chunks: 0, media: 0 };
    if (!Auth.me) return st;
    st.hasKey = !!localStorage.getItem(this.keyLS(Auth.me.uid));
    const m = this._getMeta() || {};
    st.t = m.t || 0;
    st.bytes = m.bytes || 0;
    st.chunks = m.chunks || 0;
    st.media = m.media || 0;
    return st;
  }
};

/* ---- interceptor de escrituras: cualquier LS.set de datos de la cuenta
   programa el auto-respaldo (instalado tras storage.js y antes de app.js) ---- */
(function () {
  const origSet = LS.set.bind(LS);
  LS.set = (k, v) => {
    origSet(k, v);
    try { Backup.onLocalWrite(k); } catch (e) {}
  };
})();

/* ---- al pasar la app a segundo plano: respaldo best-effort de datos ---- */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && Auth.me && !Backup._busy && Backup.enabled() && Backup.hasKey() && Mqtt.connected) {
    Backup.flush({ media: false }).catch(() => {});
  }
});
