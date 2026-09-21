/* calls.js — llamadas de voz y video P2P con WebRTC (PeerJS)
   - peer id determinista: nexo_<usuario>
   - Saliente: getUserMedia → peer.call() con metadata (nombre, video)
   - Entrante: overlay con avatar pulsante,Responder / Rechazar
   - En llamada: micrófono/cámara conmutables, PiP local, cronómetro
   - Tono de timbre sintetizado; llamada perdida → notificación          */
'use strict';

const Calls = {
  peer: null,
  call: null,
  state: 'idle', /* idle | out | in | connecting | active */
  meta: null,
  localStream: null,
  _video: false,
  _outTimer: null,
  _durTimer: null,
  _t0: 0,

  init() {
    if (this.peer || !Auth.me) return;
    try {
      this.peer = new Peer('nexo_' + Auth.me.uid, { debug: 0 });
      this.peer.on('call', (inc) => this.onIncoming(inc));
      this.peer.on('error', (e) => this.onError(e));
      this.peer.on('disconnected', () => {
        if (this.peer) { try { this.peer.reconnect(); } catch (e) {} }
      });
    } catch (e) {
      console.warn('PeerJS no disponible', e);
    }
  },

  onError(e) {
    const t = e && e.type;
    if (t === 'peer-unavailable') {
      UI.toast('El usuario no está disponible para llamadas.');
      if (this.meta && this.meta.from && !Presence.isOnline(this.meta.from)) {
        /* aviso push de llamada perdida aunque tenga la app cerrada */
        Push.notify(this.meta.from, 'Llamada perdida', `${Auth.me.name} intentó llamarte`, { chat: this.meta.from });
      }
      this.teardown();
    } else if (t === 'unavailable-id') {
      console.warn('[peer] id en uso (otra ventana)');
    } else if (t === 'browser-incompatible') {
      UI.toast('Tu navegador no soporta WebRTC.');
    } else {
      console.warn('[peer]', t, e);
    }
  },

  /* ================== llamada saliente ================== */
  async start(fuid, video) {
    if (this.state !== 'idle') { UI.toast('Ya hay una llamada en curso.'); return; }
    if (!Presence.isOnline(fuid)) { UI.toast(`${Friends.name(fuid)} está desconectado.`); return; }
    if (!this.peer || this.peer.disconnected) { UI.toast('El servicio de llamadas aún se está conectando. Espera unos segundos.'); return; }

    this._video = !!video;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
      });
    } catch (e) {
      UI.toast('No se pudo acceder al micrófono/cámara. Revisa los permisos.');
      return;
    }

    const name = Friends.name(fuid);
    this.state = 'out';
    this.meta = { from: fuid, name, video: !!video };
    this.showOverlay('out', name);
    Sound.startRing();

    try {
      this.call = this.peer.call('nexo_' + fuid, this.localStream, {
        metadata: { from: Auth.me.uid, name: Auth.me.name, video: !!video }
      });
    } catch (e) {
      console.warn('call()', e);
      this.teardown();
      UI.toast('No se pudo iniciar la llamada.');
      return;
    }
    this.wire(this.call);

    this._outTimer = setTimeout(() => {
      if (this.state === 'out' || this.state === 'connecting') {
        UI.toast(`${name} no responde`);
        Notify.onMissedCall({ from: fuid, name });
        if (!Presence.isOnline(fuid)) {
          Push.notify(fuid, 'Llamada perdida', `${Auth.me.name} intentó llamarte`, { chat: fuid });
        }
        this.hangup();
      }
    }, 45000);
  },

  /* ================== llamada entrante ================== */
  onIncoming(inc) {
    if (this.state !== 'idle') {
      try { inc.close(); } catch (e) {}
      return;
    }
    this.meta = (inc && inc.metadata) || {};
    if (!this.meta.from) this.meta.from = 'desconocido';
    this.call = inc;
    this.state = 'in';
    this._video = !!this.meta.video;
    this.showOverlay('in', this.meta.name || 'Alguien');
    Sound.startRing();
    Notify.onIncomingCall(this.meta);
    this.wire(inc);
  },

  async accept() {
    if (!this.call || this.state !== 'in') return;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: this._video ? { width: { ideal: 1280 } } : false
      });
    } catch (e) {
      UI.toast('No se pudo acceder al micrófono.');
      return;
    }
    Sound.stopRing();
    this.state = 'connecting';
    this.showOverlay('connecting', this.meta.name || '');
    try { this.call.answer(this.localStream); } catch (e) { this.teardown(); }
  },

  decline() {
    try { if (this.call) this.call.close(); } catch (e) {}
    this.teardown();
  },

  wire(call) {
    call.on('stream', (remote) => {
      const wasOut = this.state === 'out' || this.state === 'connecting';
      this.state = 'active';
      Sound.stopRing();
      clearTimeout(this._outTimer);
      this.showOverlay('active', (this.meta && this.meta.name) || '', remote);
      this._t0 = Date.now();
      clearInterval(this._durTimer);
      this._durTimer = setInterval(() => this._tick(), 1000);
      void wasOut;
    });
    call.on('close', () => this.onClosed());
    call.on('error', (e) => { console.warn('call error', e); this.onClosed(); });
  },

  onClosed() {
    if (this.state === 'in') {
      /* sonó pero nunca se respondió → llamada perdida */
      Notify.onMissedCall({ from: this.meta && this.meta.from, name: (this.meta && this.meta.name) || 'Desconocido' });
      Sound.stopRing();
    }
    if (this.state !== 'idle') Sound.hangup();
    this.teardown();
  },

  hangup() {
    try { if (this.call) this.call.close(); } catch (e) {}
    if (this.state !== 'idle') Sound.hangup();
    this.teardown();
  },

  teardown() {
    Sound.stopRing();
    clearTimeout(this._outTimer);
    clearInterval(this._durTimer);
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    }
    this.localStream = null;
    this.call = null;
    this.state = 'idle';
    this.meta = null;
    this._video = false;
    this._t0 = 0;
    this.hideOverlay();
  },

  toggleMic() {
    if (!this.localStream) return;
    const tracks = this.localStream.getAudioTracks();
    if (!tracks.length) return;
    const next = !tracks[0].enabled;
    tracks.forEach((t) => { t.enabled = next; });
    const btn = $('#callControls [data-act="mic"]');
    if (btn) {
      btn.classList.toggle('toggled', !next);
      btn.querySelector('use').setAttribute('href', next ? '#i-mic' : '#i-mic-off');
    }
  },

  toggleCam() {
    if (!this.localStream) return;
    const tracks = this.localStream.getVideoTracks();
    if (!tracks.length) return;
    const next = !tracks[0].enabled;
    tracks.forEach((t) => { t.enabled = next; });
    const btn = $('#callControls [data-act="cam"]');
    if (btn) {
      btn.classList.toggle('toggled', !next);
      btn.querySelector('use').setAttribute('href', next ? '#i-video' : '#i-cam-off');
    }
    const lv = $('#localVideo');
    if (lv) lv.style.visibility = next ? 'visible' : 'hidden';
  },

  _tick() {
    const el = $('#callTimer');
    if (!el) return;
    const s = Math.max(0, Math.floor((Date.now() - this._t0) / 1000));
    el.hidden = false;
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  },

  /* ================== overlay ================== */
  showOverlay(st, name, remoteStream) {
    const ov = $('#callOverlay');
    ov.hidden = false;
    ov.classList.toggle('ring', st === 'in' || st === 'out');

    const rv = $('#remoteVideo');
    const lv = $('#localVideo');
    const hasVideo = !!(remoteStream && remoteStream.getVideoTracks().length);

    if (remoteStream) {
      try { rv.srcObject = remoteStream; } catch (e) {}
      rv.play().catch(() => {});
    } else {
      try { rv.srcObject = null; } catch (e) {}
    }
    if (this.localStream) {
      try { lv.srcObject = this.localStream; } catch (e) {}
      lv.play().catch(() => {});
    }
    ov.classList.toggle('video-active', st === 'active' && hasVideo);

    const av = $('#callAvatar');
    const avUid = (this.meta && this.meta.from) || name || 'n';
    av.innerHTML = Avatars.html(avUid, name || '?');
    avatarStyle(av, avUid);
    $('#callName').textContent = name || '';
    const txt = { out: 'Llamando…', in: 'Llamada entrante', connecting: 'Conectando…', active: 'En llamada' }[st] || '';
    $('#callState').textContent = this._video && st !== 'active' ? `${txt} · video` : txt;
    const timer = $('#callTimer');
    timer.hidden = st !== 'active';
    timer.textContent = '00:00';

    this.renderControls(st);
  },

  renderControls(st) {
    const c = $('#callControls');
    const micBtn = () => `<button class="call-btn" data-act="mic" title="Silenciar micrófono"><svg class="icon"><use href="#i-mic"/></svg></button>`;
    const camBtn = () => `<button class="call-btn" data-act="cam" title="Apagar cámara"><svg class="icon"><use href="#i-video"/></svg></button>`;
    const hangBtn = () => `<button class="call-btn hangup" data-act="hangup" title="Colgar"><svg class="icon"><use href="#i-phone"/></svg></button>`;

    if (st === 'out' || st === 'connecting') c.innerHTML = hangBtn();
    else if (st === 'in') c.innerHTML = `<button class="call-btn hangup" data-act="decline" title="Rechazar"><svg class="icon"><use href="#i-phone"/></svg></button>
      <button class="call-btn answer" data-act="accept" title="Responder"><svg class="icon"><use href="#i-phone"/></svg></button>`;
    else if (st === 'active') c.innerHTML = micBtn() + (this._video ? camBtn() : '') + hangBtn();
    else c.innerHTML = '';
  },

  hideOverlay() {
    const ov = $('#callOverlay');
    if (!ov) return;
    ov.hidden = true;
    ov.classList.remove('ring', 'video-active');
    try {
      $('#remoteVideo').srcObject = null;
      $('#localVideo').srcObject = null;
    } catch (e) {}
    $('#callTimer').hidden = true;
    $('#callControls').innerHTML = '';
  }
};
