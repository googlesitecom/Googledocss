/* sound.js — efectos de sonido sintetizados con WebAudio (sin archivos)
   v6: banco de sonidos renovado con más calidad y coherencia:
   - Cadena maestra: gain (volumen ajustable) → compresor suave → salida
   - Envolventes con ataque/release, capas de osciladores desafinados
     y filtro lowpass → sonidos más «de app», menos pitidos
   - Vibración en móvil para mensajes y llamadas (si está activada)
   - API compatible con la anterior: msg(), chime(), hangup(),
     startRing()/stopRing() + sonidos nuevos (send, connect, join…)   */
'use strict';

const Sound = {
  ctx: null,
  master: null,
  _ringTimer: null,
  _vibrOk: ('vibrate' in navigator),

  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  /* cadena maestra con compresor: evita picos desagradables */
  _dest() {
    const c = this.ensure();
    if (!c) return null;
    if (!this.master) {
      try {
        const g = c.createGain();
        const comp = c.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 22;
        comp.ratio.value = 6;
        comp.attack.value = 0.004;
        comp.release.value = 0.18;
        g.connect(comp);
        comp.connect(c.destination);
        this.master = g;
      } catch (e) { this.master = null; }
    }
    if (this.master) {
      const v = (typeof Settings !== 'undefined' && Settings.volume != null) ? Settings.volume : 0.8;
      this.master.gain.value = Math.max(0, Math.min(1, v));
    }
    return this.master || c.destination;
  },

  vol() { return (typeof Settings !== 'undefined' && Settings.volume != null) ? Settings.volume : 0.8; },

  /* nota con timbre: 2 osciladores desafinados + lowpass + envolvente */
  note(freq, { dur = 0.14, delay = 0, vol = 0.16, type = 'sine', detune = 4, cut = 5200, attack = 0.012, pan = 0 } = {}) {
    const c = this.ensure();
    if (!c || !this.vol()) return;
    try {
      const t = c.currentTime + delay;
      const dest = this._dest();
      const g = c.createGain();
      let last = g;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol * this.vol()), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const filt = c.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = cut;
      g.connect(filt);
      if (pan && c.createStereoPanner) {
        const p = c.createStereoPanner();
        p.pan.value = pan;
        filt.connect(p);
        last = p;
      } else last = filt;
      last.connect(dest);
      for (const dt of [0, detune]) {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        o.detune.value = dt;
        o.connect(g);
        o.start(t);
        o.stop(t + dur + 0.06);
      }
    } catch (e) {}
  },

  /* pequeño «shimmer» armónico agudo y suave */
  shimmer(freq, { delay = 0, vol = 0.05, dur = 0.5 } = {}) {
    this.note(freq, { dur, delay, vol, type: 'triangle', detune: 9, cut: 9000, attack: 0.05 });
  },

  vibrate(pattern) {
    if (!(typeof Settings !== 'undefined' && Settings.vibrate)) return;
    if (this._vibrOk) { try { navigator.vibrate(pattern); } catch (e) {} }
  },

  /* ============ banco de sonidos ============ */

  /* mensaje ENVIADO: pop suave ascendente (confirmación) */
  send() {
    this.note(540, { dur: 0.07, vol: 0.12, type: 'sine', cut: 4200 });
    this.note(790, { dur: 0.1, vol: 0.1, type: 'sine', delay: 0.055, cut: 5200 });
  },

  /* mensaje RECIBIDO: dos notas suaves con brillo (estilo mensajería) */
  msg() {
    this.note(1318, { dur: 0.12, vol: 0.14, type: 'sine', cut: 6500 });        /* E6 */
    this.note(1568, { dur: 0.2, vol: 0.12, type: 'sine', delay: 0.11, cut: 6500 }); /* G6 */
    this.shimmer(2637, { delay: 0.11, vol: 0.028, dur: 0.34 });                 /* E7 destello */
    this.vibrate([28]);
  },

  /* evento social (solicitud, aceptado, invitación a grupo): arpegio cálido */
  chime() {
    this.note(1046, { dur: 0.14, vol: 0.12 });                                  /* C6 */
    this.note(1318, { dur: 0.14, vol: 0.11, delay: 0.09 });                     /* E6 */
    this.note(1568, { dur: 0.3, vol: 0.12, delay: 0.18 });                      /* G6 */
    this.shimmer(2093, { delay: 0.18, vol: 0.03 });
    this.vibrate([20, 60, 20]);
  },

  /* reacción recibida: mini destello */
  react() {
    this.note(1760, { dur: 0.09, vol: 0.09, type: 'triangle', cut: 8200 });
    this.shimmer(2637, { delay: 0.05, vol: 0.02, dur: 0.22 });
  },

  /* llamada CONECTADA: tres notas ascendentes */
  connect() {
    this.note(784, { dur: 0.11, vol: 0.13 });
    this.note(988, { dur: 0.11, vol: 0.13, delay: 0.1 });
    this.note(1318, { dur: 0.24, vol: 0.14, delay: 0.2, cut: 7000 });
    this.shimmer(1976, { delay: 0.2, vol: 0.026 });
  },

  /* alguien se une / sale de la llamada de grupo */
  join() { this.note(880, { dur: 0.1, vol: 0.1, type: 'triangle', cut: 6400 }); this.note(1174, { dur: 0.12, vol: 0.09, delay: 0.08, cut: 6400 }); },
  leave() { this.note(740, { dur: 0.1, vol: 0.09, type: 'triangle', cut: 5200 }); this.note(554, { dur: 0.13, vol: 0.08, delay: 0.08, cut: 4800 }); },

  /* fin de llamada: dos notas descendentes suaves */
  hangup() {
    this.note(494, { dur: 0.13, vol: 0.12 });
    this.note(330, { dur: 0.24, vol: 0.11, delay: 0.12 });
  },

  /* error: zumbido bajo corto */
  error() {
    this.note(196, { dur: 0.16, vol: 0.12, type: 'square', cut: 900 });
    this.note(185, { dur: 0.18, vol: 0.1, type: 'square', delay: 0.14, cut: 800 });
  },

  /* tono de llamada ENTRANTE, en bucle (melódico moderno de 2 frases) */
  startRing() {
    this.stopRing();
    const once = () => {
      /* frase A */
      this.note(988, { dur: 0.2, vol: 0.15, type: 'sine', cut: 7000 });
      this.note(1318, { dur: 0.2, vol: 0.14, delay: 0.22, cut: 7000 });
      this.note(988, { dur: 0.2, vol: 0.13, delay: 0.44, cut: 7000 });
      this.note(1318, { dur: 0.34, vol: 0.15, delay: 0.66, cut: 7200 });
      this.shimmer(1976, { delay: 0.66, vol: 0.03, dur: 0.5 });
      /* frase B (contesta distinto) */
      this.note(880, { dur: 0.2, vol: 0.13, delay: 1.5, cut: 6800 });
      this.note(1174, { dur: 0.4, vol: 0.14, delay: 1.72, cut: 6800 });
    };
    once();
    this._ringTimer = setInterval(once, 2800);
  },
  stopRing() {
    if (this._ringTimer) { clearInterval(this._ringTimer); this._ringTimer = null; }
  }
};

/* desbloqueo de audio tras el primer gesto del usuario */
document.addEventListener('pointerdown', () => Sound.ensure(), { once: true });
