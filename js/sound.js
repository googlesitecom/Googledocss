/* sound.js — sonidos sintetizados con WebAudio (sin archivos) */
'use strict';

const Sound = {
  ctx: null,
  _ringTimer: null,
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },
  tone(freq, dur = 0.12, type = 'sine', vol = 0.13, delay = 0) {
    const c = this.ensure();
    if (!c) return;
    try {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.value = freq;
      o.connect(g);
      g.connect(c.destination);
      const t = c.currentTime + delay;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t);
      o.stop(t + dur + 0.05);
    } catch (e) {}
  },
  /* mensaje nuevo */
  msg() {
    this.tone(660, 0.09, 'sine', 0.11);
    this.tone(990, 0.13, 'sine', 0.09, 0.09);
  },
  /* solicitud de amistad / aceptación */
  chime() {
    [523, 659, 784].forEach((f, i) => this.tone(f, 0.16, 'sine', 0.1, i * 0.1));
  },
  /* fin de llamada */
  hangup() {
    this.tone(392, 0.16, 'sine', 0.12);
    this.tone(311, 0.22, 'sine', 0.12, 0.15);
  },
  /* tono de llamada (entrante o saliente), en bucle */
  startRing() {
    this.stopRing();
    const once = () => {
      this.tone(784, 0.35, 'triangle', 0.15);
      this.tone(988, 0.35, 'triangle', 0.13, 0.45);
      this.tone(784, 0.35, 'triangle', 0.15, 0.9);
    };
    once();
    this._ringTimer = setInterval(once, 2600);
  },
  stopRing() {
    if (this._ringTimer) { clearInterval(this._ringTimer); this._ringTimer = null; }
  }
};

/* desbloqueo de audio tras el primer gesto del usuario */
document.addEventListener('pointerdown', () => Sound.ensure(), { once: true });
