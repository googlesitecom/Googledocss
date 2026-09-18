/* spam.js — motor de detección de spam
   Un mensaje detectado como spam SE ENTREGA al chat (marcado) pero
   NO genera notificación alguna: ni toast, ni sonido, ni notificación
   del navegador, ni entrada en el centro de notificaciones, ni badge. */
'use strict';

const Spam = {
  /* ventana por remitente: [{text, ts}] */
  _win: new Map(),

  WORDS: [
    /* español */
    'ganaste', 'premio', 'sorteo', 'dinero facile', 'dinero facil', 'rich', 'enriquece',
    'gratis', 'oferta limitada', 'compra ahora', 'ultimo dia', 'descuento exclusivo',
    'crypto', 'criptomoneda', 'bitcoin', 'inversion', 'duplica tu', 'prestamo',
    'trabajo desde casa', 'gana dinero', 'click aqui', 'clic aqui', 'haz clic aqui',
    'sigue este enlace', 'verifica tu cuenta', 'has sido seleccionado', 'loteria',
    'premio unico', 'urgente', 'promo', 'casino', 'apuesta', 'pastilla', 'viagra',
    /* inglés */
    'free money', 'win a prize', 'claim your', 'click here', 'buy now', 'limited offer',
    'crypto pump', 'double your', 'hot singles', 'viagra', 'casino', 'loan approved'
  ],

  /* Devuelve {isSpam, score, reasons} */
  check(uid, text) {
    const t = String(text ?? '').trim();
    const now = Date.now();
    const norm = t.toLowerCase();

    /* historial del remitente (ventana de 45 s) */
    let arr = this._win.get(uid) || [];
    arr.push({ text: t, norm, ts: now });
    arr = arr.filter((m) => now - m.ts < 45000).slice(-30);
    this._win.set(uid, arr);

    let score = 0;
    const reasons = [];

    /* 1. ráfaga de mensajes */
    const in5 = arr.filter((m) => now - m.ts < 5000).length;
    const in30 = arr.length;
    if (in5 >= 5) { score += 60; reasons.push(`Ráfaga: ${in5} mensajes en 5 s`); }
    else if (in30 >= 10) { score += 45; reasons.push(`Ráfaga: ${in30} mensajes en 30 s`); }

    /* 2. repetición del mismo texto */
    if (t.length > 0) {
      const dup = arr.filter((m) => m.norm === norm && now - m.ts < 20000).length;
      if (dup >= 4) { score += 50; reasons.push(`Mismo mensaje repetido x${dup}`); }
      else if (dup === 3) { score += 30; reasons.push(`Mismo mensaje repetido x${dup}`); }
    }

    /* 3. mayúsculas excesivas */
    const letters = t.replace(/[^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/g, '');
    if (letters.length >= 10) {
      const caps = letters.replace(/[^A-ZÁÉÍÓÚÜÑ]/g, '').length / letters.length;
      if (caps > 0.7) { score += 25; reasons.push('Mayúsculas excesivas'); }
    }

    /* 4. carácter repetido en cadena */
    if (/(.)\1{6,}/.test(t)) { score += 25; reasons.push('Caracteres repetidos en cadena'); }

    /* 5. exceso de emojis */
    let emojis = 0;
    try { emojis = (t.match(/\p{Extended_Pictographic}/gu) || []).length; } catch (e) {}
    if (emojis >= 10 || (t.length >= 8 && emojis / t.length > 0.4)) {
      score += 20; reasons.push(`Exceso de emojis (${emojis})`);
    }

    /* 6. puntuación repetida */
    if (/([!¡?*·.])\1{4,}/.test(t)) { score += 15; reasons.push('Puntuación excesiva'); }

    /* 7. enlaces */
    const links = (t.match(/https?:\/\/|www\.|\b(?:com|net|xyz|es|mx|info|io|app|biz)\b/gi) || []).length;
    if (links >= 3) { score += 35; reasons.push(`Demasiados enlaces (${links})`); }
    else if (links === 2) { score += 12; reasons.push('Varios enlaces'); }

    /* 8. palabras típicas de spam */
    const hits = this.WORDS.filter((w) => norm.includes(w));
    if (hits.length) { score += Math.min(15 * hits.length, 40); reasons.push(`Palabras sospechosas (${hits.slice(0, 3).join(', ')})`); }

    /* umbral según sensibilidad configurada */
    const sens = (typeof Settings !== 'undefined' && Settings.sens) || 'medio';
    const th = { alto: 35, medio: 50, bajo: 70 }[sens] || 50;

    return { isSpam: score >= th, score, reasons };
  },

  /* reiniciar ventana de un usuario (p. ej. al abrir su chat) */
  reset(uid) { this._win.delete(uid); }
};
