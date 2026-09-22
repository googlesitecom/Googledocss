/* voice.js — mensajes de voz reales
   - Grabación con MediaRecorder (Opus/WebM, MP4 en Safari)
   - Envío por los mismos chunks MQTT que las imágenes
   - Reproductor propio: onda generada del audio real (WebAudio),
     progreso, duración y velocidad 1x/1.5x/2x
   - Máximo 2 minutos por mensaje                          */
'use strict';

const VOICE_MAX_MS = 120000;
const VOICE_MAX_B64 = 2 * 1024 * 1024; /* 2 MB en base64 ≈ 1.5 MB de audio */

const Voice = {
  rec: null,
  stream: null,
  chunks: [],
  t0: 0,
  dur: 0,
  mime: '',
  _timer: null,
  _active: false,

  /* tipos soportados, por orden de preferencia */
  pickMime() {
    const cands = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',           /* Safari */
      'audio/ogg;codecs=opus'
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    return cands.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }) || '';
  },

  supported() {
    return typeof MediaRecorder !== 'undefined' &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
      !!this.pickMime();
  },

  /* ---------- empezar a grabar ---------- */
  async start() {
    if (this._active) return;
    if (!this.supported()) { UI.toast('Tu navegador no soporta grabar audio.'); return; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
    } catch (e) {
      UI.toast('No se pudo acceder al micrófono. Revisa los permisos.');
      return;
    }
    this.mime = this.pickMime();
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, {
      mimeType: this.mime || undefined,
      audioBitsPerSecond: 24000
    });
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };

    this._active = true;
    this.t0 = Date.now();
    this.rec.start(250);

    /* UI */
    const bar = $('#recBar');
    if (bar) bar.hidden = false;
    $('#composer').classList.add('recording');
    this._timer = setInterval(() => this._tick(), 200);
  },

  _tick() {
    const el = $('#recTime');
    if (!el) return;
    const ms = Date.now() - this.t0;
    if (ms >= VOICE_MAX_MS) { this.stop(true); return; }
    const s = Math.floor(ms / 1000);
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const bar = $('#recWave');
    if (bar) {
      /* pequeña onda animada mientras se graba */
      const n = bar.children.length;
      for (let i = 0; i < n; i++) {
        const h = 8 + Math.abs(Math.sin(Date.now() / 170 + i * 0.9)) * 22;
        bar.children[i].style.height = h.toFixed(1) + 'px';
      }
    }
  },

  /* ---------- terminar (send = enviar, false = cancelar) ---------- */
  stop(send) {
    if (!this._active) return;
    this._active = false;
    clearInterval(this._timer);
    const dur = Date.now() - this.t0;
    this.dur = dur;

    const finish = () => {
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      this.stream = null;
      const bar = $('#recBar');
      if (bar) bar.hidden = true;
      $('#composer').classList.remove('recording');
      const el = $('#recTime');
      if (el) el.textContent = '00:00';
    };

    const rec = this.rec;
    this.rec = null;
    if (!rec || rec.state === 'inactive') { finish(); return; }

    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mime || 'audio/webm' });
      this.chunks = [];
      finish();
      if (send) {
        if (dur < 700) { UI.toast('Mensaje demasiado corto.'); return; }
        Chat.sendVoice(blob, Math.round(dur / 1000));
      }
    };
    try { rec.stop(); } catch (e) { finish(); }
  },

  cancel() { this.stop(false); },

  /* ---------- onda real del audio (para el reproductor) ---------- */
  async peaks(blob, n = 26) {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await blob.arrayBuffer();
      const audio = await ac.decodeAudioData(buf.slice(0));
      const ch = audio.getChannelData(0);
      const block = Math.floor(ch.length / n) || 1;
      const peaks = [];
      let max = 0.0001;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        const start = i * block;
        for (let j = 0; j < block; j += 8) sum += Math.abs(ch[start + j] || 0);
        const v = sum / (block / 8);
        peaks.push(v);
        if (v > max) max = v;
      }
      ac.close().catch(() => {});
      return peaks.map((v) => Math.max(0.14, v / max)); /* normalizado 0.14..1 */
    } catch (e) {
      return Array.from({ length: n }, (_, i) => 0.35 + 0.3 * Math.abs(Math.sin(i)));
    }
  },

  fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    return sec < 60 ? `0:${String(sec).padStart(2, '0')}` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }
};
