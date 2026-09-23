/* gh.js — v11: respaldo DURADERO en GitHub (el «arcón»)
   PROBLEMA: la copia v10 vive como mensajes retenidos en el broker MQTT
   público, que NO garantiza persistencia: un reinicio o mantenimiento del
   servicio puede purgar los retenidos → tras un reinicio de fábrica del
   dispositivo (o semanas después) la copia podía haber desaparecido y con
   ella los contactos, chats y ajustes.

   SOLUCIÓN: espejar la MISMA copia cifrada (mismos chunks AES-GCM con la
   clave derivada de la contraseña) como archivos JSON del repositorio
   donde vive la propia app (Googledocss, público), en una rama dedicada
   «nx-backups» que no ensucia main ni dispara reconstrucciones de Pages:
     - bk/<uid>/dm.json            manifiesto de datos (sal + iv + nº chunks)
     - bk/<uid>/d/<i>.json         chunk i del blob cifrado (chats/ajustes)
     - bk/<uid>/fm.json            manifiesto de multimedia
     - bk/<uid>/f/<id>/<i>.json    chunks cifrados de cada foto/audio
   LECTURA: raw.githubusercontent.com sin autenticar (repositorio público,
   CORS *) → un dispositivo NUEVO restaura con solo usuario+contraseña.
   ESCRITURA: API de contenidos con el token personal (PAT) del usuario,
   que se pega UNA vez en Ajustes y viaja DENTRO de la copia cifrada →
   los demás dispositivos lo recuperan solos al iniciar sesión.
   El token nunca se publica: solo sale cifrado con la contraseña.      */
'use strict';

const GH = {
  REPO: 'googlesitecom/Googledocss',
  BRANCH: 'nx-backups',
  API: 'https://api.github.com',
  RAW: 'https://raw.githubusercontent.com/googlesitecom/Googledocss/nx-backups',

  _q: null,          /* cola de escritura serializada (evita carreras de SHA) */
  _branchOk: false,

  /* ---- token de acceso personal (por cuenta y dispositivo) ----
     IMPORTANTE: se guarda JSON-codificado (LS.set lo hace igual) porque
     viaja DENTRO de la copia cifrada y la restauración parsea todos los
     valores como JSON — un valor raw rompería silenciosamente la clave. */
  patLS: (u) => `nexo_${u}_ghpat`,
  pat() {
    if (typeof Auth === 'undefined' || !Auth.me) return '';
    const raw = localStorage.getItem(this.patLS(Auth.me.uid));
    if (!raw) return '';
    try { const v = JSON.parse(raw); return typeof v === 'string' ? v : raw; }
    catch (e) { return raw; } /* valor raw de una versión anterior */
  },
  configured() { return !!this.pat(); },
  clearPat() {
    if (typeof Auth !== 'undefined' && Auth.me) {
      try { localStorage.removeItem(this.patLS(Auth.me.uid)); } catch (e) {}
    }
  },

  /* ---- rutas de los archivos (espejo de los temas MQTT bk/...) ---- */
  paths: {
    dm: (u) => `bk/${u}/dm.json`,
    d: (u, i) => `bk/${u}/d/${i}.json`,
    fm: (u) => `bk/${u}/fm.json`,
    f: (u, id, i) => `bk/${u}/f/${id}/${i}.json`
  },

  /* ---- cola serializada: una escritura cada vez (el SHA del archivo
     cambia con cada commit; en paralelo devolvería 409) ---- */
  run(task) {
    const prev = this._q || Promise.resolve();
    const next = prev.then(task, task);
    this._q = next.catch(() => {});
    return next;
  },

  _fetch(url, opts = {}, timeoutMs = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
  },

  /* ---- API autenticada (solo con PAT). 404 → null (archivo inexistente) ---- */
  async api(path, opts = {}) {
    const pat = this.pat();
    const headers = { Accept: 'application/vnd.github+json' };
    if (pat) headers.Authorization = 'Bearer ' + pat;
    let o = { ...opts, headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      o = { ...opts, headers, body: JSON.stringify(opts.body) };
    }
    const r = await this._fetch(this.API + path, o);
    if (r.status === 401) throw new Error('El token de GitHub no es válido o ha caducado.');
    if (r.status === 403) {
      const rem = r.headers.get('x-ratelimit-remaining');
      if (rem === '0') throw new Error('Límite de peticiones a GitHub alcanzado: reintenta en unos minutos.');
      throw new Error('El token no tiene permiso de escritura sobre el repositorio (ámbito «repo»).');
    }
    if (r.status === 409) throw new Error('Conflicto de escritura en GitHub (otro dispositivo escribió a la vez).');
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub respondió ' + r.status + '.');
    return r.json();
  },

  /* ---- lectura pública sin token (rama del repositorio público) ---- */
  async rawJSON(path) {
    try {
      const r = await this._fetch(`${this.RAW}/${path}?t=${Date.now()}`, { cache: 'no-store' }, 12000);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  },

  /* ---- rama dedicada nx-backups (creada sobre main la primera vez) ---- */
  async ensureBranch() {
    if (this._branchOk) return true;
    const ref = await this.api(`/repos/${this.REPO}/git/ref/heads/${this.BRANCH}`);
    if (!ref) {
      const main = await this.api(`/repos/${this.REPO}/git/ref/heads/main`);
      if (!main) throw new Error('No se encontró la rama principal del repositorio.');
      await this.api(`/repos/${this.REPO}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${this.BRANCH}`, sha: main.object.sha }
      });
    }
    this._branchOk = true;
    return true;
  },

  /* ---- escribir un archivo JSON en la rama (PUT de contenidos) ---- */
  async putFile(path, obj, msg) {
    await this.ensureBranch();
    const content = btoa(unescape(encodeURIComponent(typeof obj === 'string' ? obj : JSON.stringify(obj))));
    const cur = await this.api(`/repos/${this.REPO}/contents/${path}?ref=${this.BRANCH}&t=${Date.now()}`);
    const body = { message: msg || `nexo: ${path}`, branch: this.BRANCH, content };
    if (cur && cur.sha) body.sha = cur.sha;
    try {
      await this.api(`/repos/${this.REPO}/contents/${path}`, { method: 'PUT', body });
    } catch (e) {
      /* 409 (otro dispositivo escribió antes): releer el SHA y reintentar una vez */
      const cur2 = await this.api(`/repos/${this.REPO}/contents/${path}?ref=${this.BRANCH}&t=${Date.now()}`);
      if (!(cur2 && cur2.sha)) throw e;
      body.sha = cur2.sha;
      await this.api(`/repos/${this.REPO}/contents/${path}`, { method: 'PUT', body });
    }
    return true;
  },

  /* ---- borrar un archivo de la rama (necesita su SHA) ---- */
  async delFile(path, sha) {
    await this.ensureBranch();
    let s = sha;
    if (!s) {
      const cur = await this.api(`/repos/${this.REPO}/contents/${path}?ref=${this.BRANCH}&t=${Date.now()}`);
      s = (cur && cur.sha) || null;
    }
    if (!s) return false;
    await this.api(`/repos/${this.REPO}/contents/${path}`, {
      method: 'DELETE',
      body: { message: `nexo: borrar ${path}`, sha: s, branch: this.BRANCH }
    });
    return true;
  },

  /* ---- listar los archivos de la rama bajo un prefijo ---- */
  async list(prefix) {
    const tree = await this.api(`/repos/${this.REPO}/git/trees/${this.BRANCH}?recursive=1&t=${Date.now()}`);
    if (!tree || !Array.isArray(tree.tree)) return [];
    return tree.tree
      .filter((e) => e.type === 'blob' && e.path.startsWith(prefix))
      .map((e) => ({ path: e.path, sha: e.sha }));
  },

  /* ---- migrar la copia a otro uid (cambio de usuario): copiar los
     archivos tal cual (ya cifrados) y borrar los antiguos ---- */
  async moveUser(old, nu) {
    const files = await this.list(`bk/${old}/`);
    if (!files.length) return 0;
    for (const f of files) {
      const obj = await this.rawJSON(f.path);
      if (obj == null) continue;
      const nuPath = f.path.replace(/^bk\/[^/]+\//, `bk/${nu}/`);
      await this.run(() => this.putFile(nuPath, obj));
    }
    for (const f of files) {
      try { await this.run(() => this.delFile(f.path, f.sha)); } catch (e) {}
    }
    return files.length;
  },

  /* ---- conectar: valida el PAT contra el repositorio y crea la rama ---- */
  async connect(pat) {
    pat = String(pat || '').trim();
    if (!pat) throw new Error('Pega tu token de acceso personal de GitHub.');
    if (typeof Auth === 'undefined' || !Auth.me) throw new Error('No hay sesión activa.');
    const r = await this._fetch(`${this.API}/repos/${this.REPO}`, {
      headers: { Authorization: 'Bearer ' + pat, Accept: 'application/vnd.github+json' }
    });
    if (r.status === 401) throw new Error('El token no es válido o ha caducado: genera uno nuevo en github.com/settings/tokens.');
    if (r.status === 403) throw new Error('El token no tiene acceso al repositorio Googledocss (necesita el ámbito «repo»).');
    if (!r.ok) throw new Error('GitHub respondió ' + r.status + '.');
    const repo = await r.json();
    if (repo.permissions && repo.permissions.push === false) {
      throw new Error('El token no permite escribir en el repositorio (necesita el ámbito «repo»).');
    }
    try { localStorage.setItem(this.patLS(Auth.me.uid), JSON.stringify(pat)); } catch (e) {}
    this._branchOk = false;
    await this.ensureBranch();
    return true;
  }
};
