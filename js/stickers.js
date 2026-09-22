/* stickers.js — stickers reales
   - Galería propia: añades imágenes (PNG con transparencia o cualquier
     imagen), se comprimen a ≤320px y se guardan en tu dispositivo
     (IndexedDB + metadatos locales) — tu galería de stickers.
   - Envío: como los mensajes de imagen, por chunks MQTT con bandeja
     offline de 7 días; se ven grandes y sin burbuja (estilo WhatsApp).
   - Favoritos: cualquier sticker RECIBIDO se puede guardar en favoritos
     con el botón ★ (se copia a tu galería local).              */
'use strict';

const STK_MAX_DIM = 320;   /* px máximos del sticker */
const STK_MAX_B64 = 130000; /* ~96 KB en base64 */

const Stickers = {
  _urls: {},   /* id -> objectURL (caché) */
  tab: 'mine', /* pestaña activa del selector */

  /* ================== persistencia ================== */
  list() { return Auth.me ? LS.get(K.stickers(Auth.me.uid), []) : []; },
  save(l) { if (Auth.me) LS.set(K.stickers(Auth.me.uid), l); },
  meta(id) { return this.list().find((s) => s.id === id) || null; },
  mine() { return this.list().filter((s) => !s.fav); },
  favs() { return this.list().filter((s) => s.fav); },
  blobKey(id) { return 'stk_' + id; },

  /* objectURL con caché (para picker y burbujas propias) */
  async url(id) {
    if (this._urls[id]) return this._urls[id];
    const blob = await IDB.get(this.blobKey(id));
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    this._urls[id] = u;
    return u;
  },

  /* ================== añadir a la galería ================== */
  async addFiles(files) {
    let added = 0;
    for (const f of files) {
      try { if (await this.addFile(f)) added++; } catch (e) { console.warn('sticker', e); }
    }
    if (added) {
      UI.toast(added === 1 ? 'Sticker añadido a tu galería.' : `${added} stickers añadidos a tu galería.`);
      this.renderPicker();
    } else {
      UI.toast('No se pudo añadir el sticker (revisa que sea una imagen).');
    }
    return added;
  },

  async addFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return false;
    if (file.size > 8 * 1024 * 1024) throw new Error('La imagen supera 8 MB.');
    const { b64, w, h, mime } = await this.compress(file);
    const id = 's' + rid();
    await IDB.put(this.blobKey(id), new Blob([b64ToBlob(b64, mime)], { type: mime }));
    this.save([{ id, w, h, mime, ts: Date.now() }, ...this.list()]);
    return true;
  },

  /* WebP si está disponible (mantiene transparencia y pesa poco); PNG si no */
  async compress(file) {
    let img;
    try { img = await createImageBitmap(file); }
    catch (e) { throw new Error('Formato de imagen no soportado.'); }
    const scale = Math.min(1, STK_MAX_DIM / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    /* PNG con transparencia: NO rellenar fondo */
    ctx.drawImage(img, 0, 0, w, h);
    let dataURL = cv.toDataURL('image/webp', 0.85);
    let mime = 'image/webp';
    if (!dataURL.startsWith('data:image/webp')) { dataURL = cv.toDataURL('image/png'); mime = 'image/png'; }
    let b64 = dataURL.split(',')[1];
    let q = 0.85;
    while (b64.length > STK_MAX_B64 && q > 0.3 && mime === 'image/webp') {
      q -= 0.12;
      b64 = cv.toDataURL('image/webp', q).split(',')[1];
    }
    return { b64, w, h, mime };
  },

  /* ================== favoritos: guardar un sticker recibido ================== */
  async favFromMessage(m) {
    if (!m || !m.id) return;
    if (this.meta(m.id)) { UI.toast('Ya está en tu galería de stickers.'); return; }
    const blob = await IDB.get(m.id); /* el recibido se guardó con su msgId */
    if (!blob) { UI.toast('El sticker ya no está disponible en este dispositivo.'); return; }
    const id = 's' + rid();
    await IDB.put(this.blobKey(id), blob);
    this.save([{ id, w: m.w, h: m.h, mime: m.mime || blob.type || 'image/webp', fav: true, from: m.from, fromName: m.name, ts: Date.now() }, ...this.list()]);
    UI.toast('Sticker guardado en tus favoritos.');
    if (!$('#stkPanel').hidden) this.renderPicker();
  },

  /* ================== eliminar ================== */
  async remove(id) {
    const l = this.list().filter((s) => s.id !== id);
    this.save(l);
    try { await IDB.del(this.blobKey(id)); } catch (e) {}
    if (this._urls[id]) { try { URL.revokeObjectURL(this._urls[id]); } catch (e) {} delete this._urls[id]; }
    this.renderPicker();
  },

  /* ================== envío ================== */
  async send(id) {
    if (!Chat.active) return;
    const s = this.meta(id);
    if (!s) return;
    const blob = await IDB.get(this.blobKey(id));
    if (!blob) { UI.toast('El sticker no está disponible.'); return; }
    try {
      const b64 = await blobToB64(blob);
      const m = await Chat.sendChunked(Chat.active, {
        b64, msgT: 'stk',
        meta: { w: s.w, h: s.h, mime: s.mime || blob.type || 'image/webp' },
        blobType: s.mime || blob.type || 'image/webp'
      });
      App.renderConvoList();
      Chat.afterSend(Chat.active, m);
      this.closePicker();
    } catch (e) {
      console.warn('sendSticker', e);
      UI.toast('No se pudo enviar el sticker.');
    }
  },

  /* ================== selector (picker) ================== */
  togglePicker() {
    const p = $('#stkPanel');
    if (!p) return;
    if (p.hidden) this.openPicker(); else this.closePicker();
  },

  openPicker() {
    const p = $('#stkPanel');
    if (!p || !Chat.active) return;
    p.hidden = false;
    this.renderPicker();
  },

  closePicker() { const p = $('#stkPanel'); if (p) p.hidden = true; },

  async renderPicker() {
    const grid = $('#stkGrid');
    if (!grid) return;
    const items = this.tab === 'favs' ? this.favs() : this.mine();
    const addTile = `<button class="stk-item stk-add" data-stkadd="1" title="Añadir stickers (imágenes PNG con transparencia quedan perfectos)">
        <svg class="icon"><use href="#i-plus"/></svg></button>`;
    if (!items.length) {
      grid.innerHTML = `${addTile}<div class="stk-empty">${this.tab === 'favs'
        ? 'Sin favoritos todavía.<br>Pulsa ★ en cualquier sticker que recibas para guardarlo aquí.'
        : 'Tu galería está vacía.<br>Pulsa «+» para añadir imágenes como stickers.'}</div>`;
      return;
    }
    grid.innerHTML = addTile + items.map((s) => `
      <button class="stk-item" data-stk="${esc(s.id)}" title="Enviar sticker">
        <img data-stksrc="${esc(s.id)}" alt="">
        <span class="stk-del" data-stkdel="${esc(s.id)}" title="Eliminar de mi galería"><svg class="icon"><use href="#i-x"/></svg></span>
        ${s.fav ? '<span class="stk-fav-mark"><svg class="icon"><use href="#i-star"/></svg></span>' : ''}
      </button>`).join('');
    /* hidratar miniaturas */
    $$('img[data-stksrc]', grid).forEach(async (el) => {
      const u = await this.url(el.dataset.stksrc);
      if (u) el.src = u;
    });
  },

  onPickerClick(e) {
    if (e.target.closest('[data-stkadd]')) { $('#stkInput').click(); return; }
    const del = e.target.closest('[data-stkdel]');
    if (del) { e.stopPropagation(); this.remove(del.dataset.stkdel); return; }
    const it = e.target.closest('[data-stk]');
    if (it) this.send(it.dataset.stk);
  },

  setTab(tab) {
    this.tab = tab === 'favs' ? 'favs' : 'mine';
    $$('.stk-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === this.tab));
    this.renderPicker();
  }
};
