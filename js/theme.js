/* theme.js — personalización de apariencia
   - Color de acento: presets + matiz libre (se recalculan todas las
     variables --acc/--acc2/--grad del sistema de diseño)
   - Fondo del chat: 6 fondos predefinidos + imagen propia (se guarda
     en IndexedDB, solo en este dispositivo)
   - Se persiste en las preferencias locales (nexo_prefs)             */
'use strict';

const Theme = {
  DEFAULT_H: 172, /* teal original de Nexo */

  PRESETS: [
    { h: 172, name: 'Teal' },
    { h: 212, name: 'Azul' },
    { h: 262, name: 'Violeta' },
    { h: 330, name: 'Rosa' },
    { h: 24, name: 'Naranja' },
    { h: 88, name: 'Verde' },
    { h: 0, name: 'Rojo' }
  ],

  WALLPAPERS: [
    { id: 'none', name: 'Ninguno' },
    { id: 'aurora', name: 'Aurora' },
    { id: 'ocean', name: 'Océano' },
    { id: 'sunset', name: 'Atardecer' },
    { id: 'dots', name: 'Puntos' },
    { id: 'grid', name: 'Cuadrícula' },
    { id: 'mesh', name: 'Malla' }
  ],

  /* ---------- aplicar todo ---------- */
  apply() {
    const h = (Settings.accentH != null && isFinite(Settings.accentH)) ? Settings.accentH : this.DEFAULT_H;
    const r = document.documentElement.style;
    r.setProperty('--acc', `hsl(${h} 78% 42%)`);
    r.setProperty('--acc2', `hsl(${h} 80% 58%)`);
    r.setProperty('--acc-dark', `hsl(${h} 78% 34%)`);
    r.setProperty('--acc-soft', `hsl(${h} 80% 55% / .15)`);
    r.setProperty('--grad', `linear-gradient(135deg, hsl(${h} 82% 58%), hsl(${h} 78% 42%) 55%, hsl(${(h + 335) % 360} 72% 34%))`);
    const mc = $('#metaTheme');
    if (mc) mc.content = document.documentElement.dataset.theme === 'light' ? '#eef3f4' : '#0a1014';
    this.applyWallpaper();
  },

  applyWallpaper() {
    const box = $('#messages');
    if (!box) return;
    const wp = Settings.wp || 'none';
    const cls = this.WALLPAPERS.map((w) => 'wp-' + w.id).join(' ');
    box.classList.remove(...cls.trim().split(/\s+/));
    box.style.backgroundImage = '';
    box.style.backgroundSize = '';
    box.style.backgroundPosition = '';
    if (wp === 'none') return;
    if (wp === 'custom') {
      IDB.get('wp_custom').then((blob) => {
        if (!blob || Settings.wp !== 'custom') return;
        const u = URL.createObjectURL(blob);
        const dark = document.documentElement.dataset.theme !== 'light';
        const veil = dark ? 'rgba(10,16,20,.72)' : 'rgba(238,243,244,.72)';
        box.style.backgroundImage = `linear-gradient(${veil}, ${veil}), url("${u}")`;
        box.style.backgroundSize = 'cover';
        box.style.backgroundPosition = 'center';
      }).catch(() => {});
      return;
    }
    if (this.WALLPAPERS.some((w) => w.id === wp)) box.classList.add('wp-' + wp);
  },

  /* ---------- setters ---------- */
  setAccent(h) {
    Settings.accentH = ((Math.round(h) % 360) + 360) % 360;
    saveSettings();
    this.apply();
  },
  resetAccent() {
    Settings.accentH = null;
    saveSettings();
    this.apply();
  },
  setWallpaper(id) {
    Settings.wp = id;
    saveSettings();
    this.applyWallpaper();
  },
  async setCustomWallpaper(file) {
    if (!file || !file.type.startsWith('image/')) { UI.toast('Elige un archivo de imagen.'); return; }
    try {
      const { b64 } = await compressImage(file, 1920, 0.8);
      await IDB.put('wp_custom', b64ToBlob(b64));
      Settings.wp = 'custom';
      saveSettings();
      this.applyWallpaper();
      UI.toast('Fondo personalizado aplicado.');
    } catch (e) {
      UI.toast('No se pudo procesar la imagen.');
    }
  },
  async clearCustomWallpaper() {
    try { await IDB.del('wp_custom'); } catch (e) {}
    this.setWallpaper('none');
  }
};
