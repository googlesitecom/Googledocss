/* calls.js — llamadas de voz y video con WebRTC (PeerJS)
   - 1:1: getUserMedia → peer.call() con metadata (nombre, video)
   - GRUPO: topología en malla — cada participante llama a los miembros
     con uid MAYOR que el suyo (regla determinista: 1 conexión por par).
     Invitación por MQTT (evt) + push a desconectados; eventos del grupo
     (salir / medios) por nexo/v1/gm/<gid>/sys/call.
   - PANTALLA COMPARTIDA: getDisplayMedia + replaceTrack en todas las
     conexiones. Las llamadas de solo audio llevan una pista de video
     "dummy" (canvas negro) para que SIEMPRE exista un sender de video
     y se pueda sustituir al compartir pantalla o encender la cámara.
   - SEGUNDO PLANO REAL (multi-pestaña / multi-app):
     · Document Picture-in-Picture API (Chrome/Edge 116+): al minimizar
       se abre una VENTANA FLOTANTE siempre visible que PERSISTE mientras
       cambias de pestaña o de aplicación, con video, cronómetro y
       controles (micro, cámara, pantalla, colgar).
     · Media Session API: el sistema operativo muestra la llamada como
       medios en curso (notificación con colgar/silenciar en Android) y
       el audio remoto sigue sonando con la app en segundo plano.
     · Navegadores sin Document PiP → banner interno estilo WhatsApp
       (el audio también continúa con la pestaña oculta).                 */
'use strict';

const Calls = {
  peer: null,
  state: 'idle',   /* idle | out | in | connecting | active */
  mode: null,      /* 'p2p' | 'group' */
  meta: null,      /* p2p: {from, name, video} */
  g: null,         /* grupo: {gid, gname, callId, inviter, members[]} */
  _invite: null,   /* invitación de grupo pendiente de aceptar */

  /* Llamadas de grupo EN CURSO (para unirse tarde):
     gid -> {callId, host, hostName, gname, video, members[], ts}
     Se alimenta del estado retenido (nexo/v1/gcall/<gid>) y de los
     eventos en vivo, y se muestra como barra «Unirse» en el chat. */
  ongoing: {},
  _stateTimer: null, /* latido del estado retenido mientras estoy en llamada */

  localStream: null,   /* stream que se envía (audio + video real|dummy) */
  _audioTrack: null,
  _camTrack: null,     /* cámara real (si existe) */
  _dummyTrack: null,   /* video negro para llamadas de solo audio */
  _dummyCanvas: null,
  _dummyTimer: null,
  _screenStream: null, /* pantalla compartida */
  _video: false,

  conns: {},    /* uid -> MediaConnection */
  streams: {},  /* uid -> MediaStream remoto */
  media: {},    /* uid -> {vid:'cam'|'screen'|'none', mic:bool} (señalado por MQTT) */
  _pending: [], /* MediaConnections entrantes esperando mi aceptación */
  _retries: {}, /* uid -> nº de reintentos de llamada */
  _incoming: null, /* conexión entrante 1:1 antes de responder */

  _outTimer: null,
  _durTimer: null,
  _t0: 0,
  _minimized: false,

  /* Picture-in-Picture del documento (ventana flotante multi-pestaña) */
  _pipWin: null,       /* window flotante o null */
  _pipEls: null,       /* referencias a su UI */
  _pipVideoOn: false,  /* ¿se está mostrando video remoto en el PiP? */
  _pipClosing: false,  /* cierre intencional (no restaurar) */
  _pipGrpSig: '',      /* firma del conjunto de participantes (refresco puntual) */
  _msSet: false,       /* Media Session configurada */

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

  inCall() { return this.state !== 'idle'; },
  displayName() {
    if (this.mode === 'group' && this.g) return this.g.gname;
    return (this.meta && this.meta.name) || '';
  },

  onError(e) {
    const t = e && e.type;
    if (t === 'peer-unavailable') {
      if (this.mode === 'group' && this.g) {
        /* en grupo: ese miembro no está alcanzable ahora → reintentar */
        const msg = String((e && e.message) || '');
        const m = msg.match(/nexo_([a-z0-9_]+)/);
        const uid = m ? m[1] : null;
        if (uid && this.g.members.includes(uid)) { this._retryMember(uid); return; }
      }
      UI.toast('El usuario no está disponible para llamadas.');
      if (this.meta && this.meta.from && !Presence.isOnline(this.meta.from)) {
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

  /* ================== pistas locales ================== */
  _makeDummyVideo() {
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 90;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 160, 90);
    const st = cv.captureStream(1);
    this._dummyCanvas = cv;
    clearInterval(this._dummyTimer);
    this._dummyTimer = setInterval(() => { try { ctx.fillRect(0, 0, 160, 90); } catch (e) {} }, 2000);
    return st.getVideoTracks()[0];
  },

  async _getLocal(video) {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
    });
    this._audioTrack = mic.getAudioTracks()[0] || null;
    this._camTrack = video ? (mic.getVideoTracks()[0] || null) : null;
    const tracks = [];
    if (this._audioTrack) tracks.push(this._audioTrack);
    if (this._camTrack) tracks.push(this._camTrack);
    else { this._dummyTrack = this._makeDummyVideo(); tracks.push(this._dummyTrack); }
    this.localStream = new MediaStream(tracks);
  },

  /* ================== llamada 1:1 saliente ================== */
  async start(fuid, video) {
    if (this.state !== 'idle') { UI.toast('Ya hay una llamada en curso.'); return; }
    if (!Presence.isOnline(fuid)) { UI.toast(`${Friends.name(fuid)} está desconectado.`); return; }
    if (!this.peer || this.peer.disconnected) { UI.toast('El servicio de llamadas aún se está conectando. Espera unos segundos.'); return; }

    this._video = !!video;
    try { await this._getLocal(!!video); }
    catch (e) { UI.toast('No se pudo acceder al micrófono/cámara. Revisa los permisos.'); return; }

    this.mode = 'p2p';
    this.state = 'out';
    this.meta = { from: fuid, name: Friends.name(fuid), video: !!video };
    this.showOverlay('out', this.meta.name);
    Sound.startRing();

    try {
      const c = this.peer.call('nexo_' + fuid, this.localStream, {
        metadata: { from: Auth.me.uid, name: Auth.me.name, video: !!video }
      });
      this.conns[fuid] = c;
      this.wire(c, fuid);
    } catch (e) {
      console.warn('call()', e);
      this.teardown();
      UI.toast('No se pudo iniciar la llamada.');
      return;
    }

    this._outTimer = setTimeout(() => {
      if (this.state === 'out' || this.state === 'connecting') {
        UI.toast(`${this.meta.name} no responde`);
        Notify.onMissedCall({ from: fuid, name: this.meta.name });
        if (!Presence.isOnline(fuid)) {
          Push.notify(fuid, 'Llamada perdida', `${Auth.me.name} intentó llamarte`, { chat: fuid });
        }
        this.hangup();
      }
    }, 45000);
  },

  /* ================== llamada 1:1 entrante ================== */
  onIncoming(inc) {
    const md = (inc && inc.metadata) || {};
    if (md.gcall) return this.onIncomingGroupConn(inc);
    if (this.state !== 'idle') { try { inc.close(); } catch (e) {} return; }
    this._incoming = inc;
    this.meta = { from: md.from || 'desconocido', name: md.name || 'Alguien', video: !!md.video };
    this.mode = 'p2p';
    this._video = !!md.video;
    this.state = 'in';
    this.showOverlay('in', this.meta.name);
    Sound.startRing();
    Notify.onIncomingCall(this.meta);
  },

  async accept() {
    if (this.mode === 'group') return this.acceptGroup();
    if (!this._incoming || this.state !== 'in') return;
    try { await this._getLocal(this._video); }
    catch (e) { UI.toast('No se pudo acceder al micrófono.'); return; }
    Sound.stopRing();
    this.state = 'connecting';
    this.showOverlay('connecting', this.meta.name);
    const uid = this.meta.from;
    this.conns[uid] = this._incoming;
    this.wire(this._incoming, uid);
    try { this._incoming.answer(this.localStream); } catch (e) { this.teardown(); }
    this._incoming = null;
  },

  decline() {
    this._ending = true; /* suprime los manejadores de cierre durante el colgado */
    if (this.mode === 'group' && this.g) this._publishGrp('left');
    else if (this._incoming) { try { this._incoming.close(); } catch (e) {} }
    Object.values(this.conns).forEach((c) => { try { c.close(); } catch (e) {} });
    this.teardown();
  },

  /* ================== llamada GRUPAL: iniciar ================== */
  async startGroup(gid, video) {
    if (this.state !== 'idle') { UI.toast('Ya hay una llamada en curso.'); return; }
    const g = Groups.get(gid);
    if (!g) return;
    const others = (g.members || []).filter((u) => u !== Auth.me.uid);
    if (!others.length) { UI.toast('El grupo no tiene más miembros.'); return; }
    if (!this.peer || this.peer.disconnected) { UI.toast('El servicio de llamadas aún se está conectando. Espera unos segundos.'); return; }

    this._video = !!video;
    try { await this._getLocal(!!video); }
    catch (e) { UI.toast('No se pudo acceder al micrófono/cámara. Revisa los permisos.'); return; }

    const callId = rid();
    this.mode = 'group';
    this.state = 'out';
    this.g = { gid, gname: g.name, callId, inviter: Auth.me.uid, members: [...others] };
    this.showOverlay('out', g.name);
    Sound.startRing();

    /* estado retenido: «hay una llamada en curso en este grupo» —
       quien no entró (o abre la app más tarde) podrá UNIRSE */
    this._publishCallState();
    this._startStateHeartbeat();

    /* invitación a cada miembro (evt en vivo) + push si está desconectado */
    others.forEach((u) => {
      Mqtt.publish(T.evt(u), {
        t: 'gcall', gid, gname: g.name, callId, from: Auth.me.uid, fromName: Auth.me.name,
        video: !!video, members: g.members
      });
      if (!Presence.isOnline(u)) {
        Push.notify(u, 'Llamada de grupo perdida', `${Auth.me.name} te llamó al grupo «${g.name}»`, { chat: 'g:' + gid });
      }
    });

    /* regla de malla: solo llamo a los uid mayores que el mío */
    others.forEach((u) => { if (u > Auth.me.uid) this._callMember(u); });

    this._outTimer = setTimeout(() => this._grpTimeout(), 45000);
  },

  _grpTimeout() {
    if (this.mode !== 'group' || (this.state !== 'out' && this.state !== 'connecting')) return;
    if (!Object.keys(this.streams).length) {
      UI.toast('Nadie se unió a la llamada del grupo.');
      this.hangup();
    } else {
      Object.keys(this.conns).forEach((u) => {
        if (!this.streams[u]) { try { this.conns[u].close(); } catch (e) {} }
      });
    }
  },

  _callMember(u) {
    if (!this.g || !this.peer || this.conns[u]) return;
    try {
      const c = this.peer.call('nexo_' + u, this.localStream, {
        metadata: {
          gcall: true, gid: this.g.gid, gname: this.g.gname, callId: this.g.callId,
          from: Auth.me.uid, fromName: Auth.me.name, video: this._video,
          members: [...this.g.members, Auth.me.uid]
        }
      });
      this.conns[u] = c;
      this.wire(c, u);
    } catch (e) { console.warn('callMember', e); }
  },

  _retryMember(u) {
    if (!this.g || !this.g.members.includes(u) || this.conns[u] || this.streams[u]) return;
    const n = (this._retries[u] || 0) + 1;
    this._retries[u] = n;
    if (n > 4) return;
    setTimeout(() => { if (this.g && this.g.members.includes(u) && !this.conns[u]) this._callMember(u); }, 5000);
  },

  /* ================== invitación de grupo entrante ================== */
  onGroupInvite(m) {
    if (!m || !m.callId) return;
    if (this.state !== 'idle') return; /* ocupado en otra llamada */
    this._invite = {
      gid: m.gid, gname: m.gname || 'Grupo', callId: m.callId,
      from: m.from, fromName: m.fromName || m.from,
      video: !!m.video, members: Array.isArray(m.members) ? m.members : []
    };
    /* registrar la llamada como EN CURSO: si la rechazo (o la pierdo)
       seguirá visible la barra «Unirse» del chat del grupo */
    this.ongoing[m.gid] = {
      callId: m.callId, host: m.from, hostName: m.fromName || m.from,
      gname: m.gname || 'Grupo', video: !!m.video,
      members: (Array.isArray(m.members) ? m.members : []).filter((u) => u && u !== Auth.me.uid),
      ts: Date.now()
    };
    this._showGroupInvite();
    this._renderOngoingUI(m.gid);
  },

  /* conexión directa de grupo antes de aceptar (la llamada llegó antes que el evt) */
  onIncomingGroupConn(inc) {
    const md = (inc && inc.metadata) || {};
    if (!md.callId) { try { inc.close(); } catch (e) {} return; }
    const sameCall = (x) => x && x.callId === md.callId;

    /* ya soy parte de esta llamada (incluso como inviter en 'out') → responder ya */
    if (this.mode === 'group' && (sameCall(this.g) || sameCall(this._invite))
      && (this.state === 'active' || this.state === 'connecting' || this.state === 'out')) {
      this.conns[md.from] = inc;
      this.wire(inc, md.from);
      if (this.g && !this.g.members.includes(md.from)) this.g.members.push(md.from);
      try { inc.answer(this.localStream); } catch (e) {}
      if (this.state !== 'active') this._renderGrpMembers();
      return;
    }

    /* invitación de ESTA llamada sonando (o sin conocer aún) → guardar pendiente */
    const ringingThis = this.state === 'in' && this.mode === 'group'
      && ((this._invite && sameCall(this._invite)) || (this.g && sameCall(this.g)));
    if (this.state === 'idle' || ringingThis) {
      this._pending.push(inc);
      /* si el que llama cuelga antes de que acepte → dejar de sonar */
      inc.on('close', () => {
        if (this._ending) return;
        const idx = this._pending.indexOf(inc);
        if (idx >= 0) this._pending.splice(idx, 1);
        if (this.state === 'in' && this.mode === 'group' && this._invite
          && this._invite.callId === md.callId
          && !this._pending.some((c) => (c.metadata || {}).callId === md.callId)
          && !Object.keys(this.conns).length) {
          UI.toast('La llamada terminó antes de que aceptaras.');
          this.teardown();
        }
      });
      /* llegó antes que la invitación por evt → mostrarla desde los metadatos */
      if (!this._invite || this._invite.callId !== md.callId) {
        this._invite = {
          gid: md.gid, gname: md.gname || 'Grupo', callId: md.callId,
          from: md.from, fromName: md.fromName || md.from,
          video: !!md.video, members: Array.isArray(md.members) ? md.members : []
        };
        this._showGroupInvite();
      }
      return;
    }

    /* ocupado en otra llamada → rechazar */
    try { inc.close(); } catch (e) {}
  },

  _showGroupInvite() {
    const inv = this._invite;
    if (!inv) return;
    this.mode = 'group';
    this.state = 'in';
    this.g = {
      gid: inv.gid, gname: inv.gname, callId: inv.callId, inviter: inv.from,
      members: (inv.members || []).filter((u) => u && u !== Auth.me.uid)
    };
    this.showOverlay('in', inv.gname);
    Sound.startRing();
    Notify.onIncomingCall({ name: `${inv.gname} · ${inv.fromName}`, video: !!inv.video });
  },

  async acceptGroup() {
    const inv = this._invite;
    if (!inv) return;
    try { await this._getLocal(!!inv.video); }
    catch (e) { UI.toast('No se pudo acceder al micrófono.'); return; }
    Sound.stopRing();
    this._invite = null;
    this.state = 'connecting';
    this.g = {
      gid: inv.gid, gname: inv.gname, callId: inv.callId, inviter: inv.from,
      members: (inv.members || []).filter((u) => u && u !== Auth.me.uid)
    };
    this.showOverlay('connecting', inv.gname);

    /* responder las conexiones que ya llegaron */
    this._pending = this._pending.filter((c) => {
      const md = c.metadata || {};
      if (md.callId === inv.callId) {
        this.conns[md.from] = c;
        this.wire(c, md.from);
        if (!this.g.members.includes(md.from)) this.g.members.push(md.from);
        try { c.answer(this.localStream); } catch (e) {}
        return false;
      }
      return true;
    });

    /* y llamar a los uid mayores que el mío */
    this.g.members.forEach((u) => { if (u > Auth.me.uid) this._callMember(u); });

    /* estoy dentro: mantener el estado retenido de la llamada */
    this._publishCallState();
    this._startStateHeartbeat();
  },

  /* ================== UNIRSE a una llamada de grupo EN CURSO ==================
     Si no entraste al principio (rechazaste, abriste la app tarde o
     cambiaste de pestaña) la llamada sigue existiendo: el chat del grupo
     muestra una barra «Unirse» alimentada por el estado retenido
     nexo/v1/gcall/<gid> (latido cada 60 s, caduca a los 5 min si muere). */
  ongoingInfo(gid) {
    const o = this.ongoing[gid];
    if (!o || !o.callId) { delete this.ongoing[gid]; return null; }
    if (Date.now() - (o.ts || 0) > 6 * 60 * 1000) { delete this.ongoing[gid]; return null; }
    return o;
  },
  inThisCall(gid) {
    return !!(this.mode === 'group' && this.g && this.g.gid === gid && this.state !== 'idle');
  },

  _publishCallState() {
    if (!this.g) return;
    const parts = [...new Set([Auth.me.uid, ...Object.keys(this.streams)])];
    Mqtt.publish(T.gcall(this.g.gid), {
      t: 'gstate', gid: this.g.gid, callId: this.g.callId,
      host: this.g.inviter, hostName: (this.g.inviter === Auth.me.uid ? Auth.me.name : Friends.name(this.g.inviter)) || '',
      gname: this.g.gname, video: this._video,
      members: parts, from: Auth.me.uid, ts: Date.now()
    }, { retain: true, expiry: 300 }); /* caduca sola si el navegador muere */
  },

  _startStateHeartbeat() {
    clearInterval(this._stateTimer);
    this._stateTimer = setInterval(() => {
      if (this.mode === 'group' && this.g && this.state !== 'idle') this._publishCallState();
      else clearInterval(this._stateTimer);
    }, 60000);
  },

  /* entrada del estado retenido (nexo/v1/gcall/<gid>) */
  onCallState(gid, m) {
    if (!Auth.me) return;
    if (this.inThisCall(gid)) return;            /* mi propia llamada: la mantengo yo */
    if (!m || !m.callId || !Array.isArray(m.members)) { delete this.ongoing[gid]; }
    else {
      const mine = m.members.filter((u) => u && u !== Auth.me.uid);
      if (!mine.length) delete this.ongoing[gid]; /* ya no queda nadie */
      else this.ongoing[gid] = {
        callId: m.callId, host: m.host, hostName: m.hostName || m.host || '',
        gname: m.gname || Groups.name(gid), video: !!m.video,
        members: mine, ts: m.ts || Date.now()
      };
    }
    this._renderOngoingUI(gid);
  },

  async joinGroup(gid) {
    if (this.state !== 'idle') { UI.toast('Ya estás en una llamada. Cuelga para unirte a otra.'); return; }
    const info = this.ongoingInfo(gid);
    if (!info) { UI.toast('La llamada ya no está activa.'); this._renderOngoingUI(gid); return; }
    const g = Groups.get(gid);
    if (!this.peer || this.peer.disconnected) { UI.toast('El servicio de llamadas aún se está conectando. Espera unos segundos.'); return; }

    this._video = !!info.video;
    try { await this._getLocal(!!info.video); }
    catch (e) { UI.toast('No se pudo acceder al micrófono/cámara. Revisa los permisos.'); return; }

    this.mode = 'group';
    this.state = 'connecting';
    this.g = {
      gid, gname: (g && g.name) || info.gname || 'Grupo', callId: info.callId,
      inviter: info.host, members: (info.members || []).filter((u) => u && u !== Auth.me.uid)
    };
    delete this.ongoing[gid]; /* ya estoy dentro */
    this.showOverlay('connecting', this.g.gname);

    /* anunciar mi incorporación: los de uid MENOR me llamarán (regla de malla) */
    this._publishGrp('joining');
    this._publishCallState();
    this._startStateHeartbeat();

    /* y llamo a los uid MAYORES que el mío */
    this.g.members.forEach((u) => { if (u > Auth.me.uid) this._callMember(u); });

    this._outTimer = setTimeout(() => {
      if (this.mode === 'group' && (this.state === 'connecting') && !Object.keys(this.streams).length) {
        UI.toast('La llamada del grupo ya no está activa.');
        this.hangup();
      }
    }, 45000);
  },

  /* refrescar barra del chat + lista de conversaciones */
  _renderOngoingUI(gid) {
    this.renderOngoingBar();
    if (typeof App !== 'undefined' && App.renderConvoList) { try { App.renderConvoList(); } catch (e) {} }
  },

  renderOngoingBar() {
    const bar = $('#grpCallBar');
    if (!bar) return;
    let gid = null;
    const act = Chat.active;
    if (typeof Chat !== 'undefined' && act && String(act).startsWith('g:')) gid = String(act).slice(2);
    const info = gid ? this.ongoingInfo(gid) : null;
    if (!gid || !info || this.inThisCall(gid)) { bar.hidden = true; return; }
    const names = info.members.slice(0, 2).map((u) => Friends.name(u) || u).join(', ');
    const more = info.members.length > 2 ? ` +${info.members.length - 2}` : '';
    $('#gcMembers').textContent = `${info.members.length} ${info.members.length === 1 ? 'persona' : 'personas'} en llamada · ${names}${more}`;
    bar.hidden = false;
  },

  /* ================== eventos del grupo (MQTT) ================== */
  _publishGrp(ev, extra = {}) {
    if (!this.g) return;
    Mqtt.publish(T.gsys(this.g.gid, 'call'), {
      t: 'gcalle', ev, gid: this.g.gid, callId: this.g.callId,
      from: Auth.me.uid, fromName: Auth.me.name, ...extra
    });
  },

  onGroupEvt(gid, m) {
    if (!m || m.from === Auth.me.uid) return;

    /* ---- libro de llamadas EN CURSO (aunque yo no esté dentro) ---- */
    const og = this.ongoing[gid];
    if (og && m.callId === og.callId) {
      if (m.ev === 'left') {
        og.members = (og.members || []).filter((u) => u !== m.from);
        if (!og.members.length) delete this.ongoing[gid];
        this._renderOngoingUI(gid);
      } else if (m.ev === 'joining') {
        if (!og.members.includes(m.from)) og.members.push(m.from);
        og.ts = Date.now();
        this._renderOngoingUI(gid);
      }
    }

    if (!this.g || m.gid !== this.g.gid || m.callId !== this.g.callId) return;
    if (m.ev === 'joining') {
      /* alguien se está uniendo a mitad de la llamada */
      if (!this.g.members.includes(m.from)) this.g.members.push(m.from);
      if (m.from > Auth.me.uid) this._callMember(m.from); /* regla de malla: yo llamo a los mayores */
      if (this.state === 'active') {
        this._renderTiles();
        UI.toast(`${m.fromName || m.from} se unió a la llamada.`);
      } else this._renderGrpMembers();
      return;
    }
    if (m.ev === 'left') {
      const c = this.conns[m.from];
      if (c) {
        try { c.close(); } catch (e) {}
        /* limpieza INMEDIATA: una conexión nunca respondida puede no
           emitir 'close' (el oferente se quedaría con un conns[] zombie
           que bloquearía re-llamar al miembro si decide unirse luego) */
        this._onConnClosed(m.from);
      }
      else {
        this.g.members = this.g.members.filter((u) => u !== m.from);
        if (this.state === 'in') {
          /* estaba sonando y ya no queda nadie en la llamada */
          if (!this.g.members.length) {
            UI.toast('La llamada del grupo terminó.');
            this.teardown();
          }
        } else if (this.state === 'connecting' && !Object.keys(this.streams).length && !this.g.members.length) {
          UI.toast('Nadie se unió a la llamada del grupo.');
          this.teardown();
        } else {
          if (this.state === 'out' || this.state === 'connecting') UI.toast(`${m.fromName || m.from} no se unió a la llamada.`);
          this._renderTiles();
          this._renderGrpMembers();
        }
      }
    } else if (m.ev === 'media') {
      this.media[m.from] = { vid: m.vid || 'none', mic: m.mic !== false };
      if (this.mode === 'group') {
        if (this.state === 'active') this._renderTiles();
      }
    }
  },

  /* señalización de medios en 1:1 (cámara / pantalla / micrófono) */
  onMediaEvt(m) {
    if (!m || !m.from || m.from === Auth.me.uid) return;
    if (this.mode !== 'p2p' || !this.meta || this.meta.from !== m.from) return;
    this.media[m.from] = { vid: m.vid || 'none', mic: m.mic !== false };
    if (this.state === 'active') this._applyRemoteVideo(m.vid);
  },

  _broadcastMedia() {
    if (!this.localStream) return;
    const vid = this._screenStream ? 'screen' : (this._camTrack ? 'cam' : 'none');
    const mic = !!(this._audioTrack && this._audioTrack.enabled);
    if (this.mode === 'p2p' && this.meta && this.meta.from) {
      Mqtt.publish(T.evt(this.meta.from), { t: 'callmedia', from: Auth.me.uid, vid, mic });
    } else if (this.mode === 'group' && this.g) {
      this._publishGrp('media', { vid, mic });
    }
  },

  /* ================== conexiones ================== */
  wire(call, uid) {
    call.on('stream', (remote) => {
      this.streams[uid] = remote;
      this._attachAudio(uid, remote);
      if (this.mode === 'group') {
        if (this.state === 'out' || this.state === 'connecting') this._grpActive();
        this._renderTiles();
      } else {
        if (this.state !== 'active') {
          this.state = 'active';
          Sound.stopRing();
          clearTimeout(this._outTimer);
          this._startTimer();
        }
        this.showOverlay('active', this.meta.name, remote);
        const md = this.media[uid];
        this._applyRemoteVideo(md ? md.vid : (this._video ? 'cam' : 'none'));
      }
    });
    call.on('close', () => this._onConnClosed(uid));
    call.on('error', (e) => { console.warn('call error', e); this._onConnClosed(uid); });
  },

  _grpActive() {
    if (this.state === 'active') return;
    this.state = 'active';
    Sound.stopRing();
    clearTimeout(this._outTimer);
    this._startTimer();
    this.showOverlay('active', this.g.gname);
    this._publishCallState(); /* la llamada ya está viva: entran los que lleguen tarde */
  },

  _onConnClosed(uid) {
    if (this._ending || this.state === 'idle') return;
    const c = this.conns[uid];
    if (c) { try { c.close(); } catch (e) {} delete this.conns[uid]; }
    delete this.streams[uid];
    this._detachAudio(uid);

    if (this.mode === 'group' && this.g) {
      this.g.members = this.g.members.filter((u) => u !== uid);
      if (this.state === 'active' || this.state === 'connecting') {
        if (!Object.keys(this.conns).length && !Object.keys(this.streams).length) {
          UI.toast('La llamada del grupo terminó.');
          this.teardown();
        } else {
          if (this.state === 'active') this._renderTiles();
          else this._renderGrpMembers();
        }
      } else if (this.state === 'out') {
        /* sigo LLAMANDO (nadie ha entrado aún o alguien declinó):
           la llamada NO muere — quien declinó puede UNIRSE desde el
           chat; el _grpTimeout la cierra si al final no entra nadie */
        this._renderGrpMembers();
      }
    } else if (this.state !== 'idle') {
      this.onClosed();
    }
  },

  onClosed() {
    if (this.state === 'in') {
      Notify.onMissedCall({ from: (this.meta && this.meta.from) || '', name: (this.meta && this.meta.name) || 'Desconocido' });
      Sound.stopRing();
    }
    if (this.state !== 'idle') Sound.hangup();
    this.teardown();
  },

  hangup() {
    this._ending = true;
    if (this.mode === 'group' && this.g) this._publishGrp('left');
    Object.values(this.conns).forEach((c) => { try { c.close(); } catch (e) {} });
    if (this.state !== 'idle') Sound.hangup();
    this.teardown();
  },

  teardown() {
    this._ending = true;
    Sound.stopRing();
    clearTimeout(this._outTimer);
    clearInterval(this._durTimer);
    clearInterval(this._dummyTimer);
    clearInterval(this._stateTimer);
    this._dummyTimer = null;

    /* estado retenido de la llamada de grupo: actualizo la lista de
       participantes sin mí; si era el último → limpio el estado
       (la barra «Unirse» desaparece para todos).
       OJO: si solo estaba SONANDO (rechacé) nunca estuve dentro →
       no tocar el estado: lo mantiene quien está en la llamada.     */
    if (this.mode === 'group' && this.g && this.state !== 'in') {
      const rest = [...new Set(Object.keys(this.streams))].filter((u) => u !== Auth.me.uid);
      if (rest.length) {
        Mqtt.publish(T.gcall(this.g.gid), {
          t: 'gstate', gid: this.g.gid, callId: this.g.callId,
          host: this.g.inviter, hostName: (this.g.inviter === Auth.me.uid ? Auth.me.name : Friends.name(this.g.inviter)) || '',
          gname: this.g.gname, video: this._video,
          members: rest, from: Auth.me.uid, ts: Date.now()
        }, { retain: true, expiry: 300 });
      } else {
        Mqtt.publish(T.gcall(this.g.gid), '', { retain: true }); /* última en salir: limpiar */
      }
    }

    Object.values(this.conns).forEach((c) => { try { c.close(); } catch (e) {} });
    this._pending.forEach((c) => { try { c.close(); } catch (e) {} });
    this.conns = {}; this.streams = {}; this.media = {}; this._pending = []; this._retries = {};
    this._detachAllAudio();

    if (this._screenStream) { try { this._screenStream.getTracks().forEach((t) => t.stop()); } catch (e) {} this._screenStream = null; }
    if (this.localStream) { try { this.localStream.getTracks().forEach((t) => t.stop()); } catch (e) {} }
    if (this._camTrack && (!this.localStream || !this.localStream.getTracks().includes(this._camTrack))) {
      try { this._camTrack.stop(); } catch (e) {}
    }
    this.localStream = null; this._audioTrack = null; this._camTrack = null; this._dummyTrack = null; this._dummyCanvas = null;
    if (this._incoming) { try { this._incoming.close(); } catch (e) {} this._incoming = null; }

    this.state = 'idle'; this.mode = null; this.meta = null; this.g = null; this._invite = null;
    this._video = false; this._t0 = 0; this._minimized = false;

    this._closePip();
    this._clearMediaSession();
    const b = $('#callBanner');
    if (b) b.hidden = true;
    const gcb = $('#grpCallBar');
    if (gcb) gcb.hidden = true;
    const tiles = $('#callTiles');
    if (tiles) { tiles.innerHTML = ''; tiles.hidden = true; }
    const gm = $('#callGrpMembers');
    if (gm) gm.hidden = true;
    this.hideOverlay();
    this._ending = false;
    if (typeof App !== 'undefined') App.updateTitle();
    /* re-evaluar si hay otra llamada en curso visible en el chat */
    this.renderOngoingBar();
  },

  /* ================== micrófono / cámara / pantalla ================== */
  toggleMic() {
    if (!this._audioTrack) return;
    const next = !this._audioTrack.enabled;
    this._audioTrack.enabled = next;
    const btn = $('#callControls [data-act="mic"]');
    if (btn) {
      btn.classList.toggle('toggled', !next);
      btn.querySelector('use').setAttribute('href', next ? '#i-mic' : '#i-mic-off');
    }
    this._broadcastMedia();
    this._pipSyncControls();
    if (this.mode === 'group' && this.state === 'active') this._renderTiles();
  },

  async toggleCam() {
    if (!this.localStream) return;
    const cur = this.localStream.getVideoTracks()[0];
    /* cámara ya activa → solo silenciar/activar */
    if (cur && cur === this._camTrack) {
      const next = !cur.enabled;
      cur.enabled = next;
      const btn = $('#callControls [data-act="cam"]');
      if (btn) {
        btn.classList.toggle('toggled', !next);
        btn.querySelector('use').setAttribute('href', next ? '#i-video' : '#i-cam-off');
      }
      const lv = $('#localVideo');
      if (lv) lv.style.visibility = next ? 'visible' : 'hidden';
      this._pipSyncControls();
      return;
    }
    /* llamada de audio (o compartiendo pantalla): encender la cámara */
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      this._camTrack = st.getVideoTracks()[0];
      if (this._screenStream) this._stopScreen();
      else this._replaceVideoTrack(this._camTrack);
      this._video = true;
      const lv = $('#localVideo');
      if (lv) { try { lv.srcObject = this.localStream; lv.play().catch(() => {}); } catch (e) {} lv.style.visibility = 'visible'; }
      this._broadcastMedia();
      this._pipSyncControls();
      this._pipSyncMedia();
      if (this.mode === 'group' && this.state === 'active') this._renderTiles();
    } catch (e) {
      UI.toast('No se pudo acceder a la cámara.');
    }
  },

  async toggleScreen() {
    if (this._screenStream) { this._stopScreen(); return; }
    if (!this.localStream) return;
    try {
      const st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      this._screenStream = st;
      const track = st.getVideoTracks()[0];
      if (track && track.addEventListener) track.addEventListener('ended', () => this._stopScreen());
      this._replaceVideoTrack(track);
      const lv = $('#localVideo');
      if (lv) { try { lv.srcObject = st; lv.play().catch(() => {}); } catch (e) {} lv.style.visibility = 'visible'; }
      const ov = $('#callOverlay');
      if (ov) ov.classList.add('local-screen');
      const btn = $('#callControls [data-act="screen"]');
      if (btn) btn.classList.add('toggled');
      this._broadcastMedia();
      this._pipSyncControls();
      this._pipSyncMedia();
      if (this.mode === 'group' && this.state === 'active') this._renderTiles();
      UI.toast('Compartiendo tu pantalla.');
    } catch (e) {
      if (e && e.name !== 'NotAllowedError') { console.warn('getDisplayMedia', e); UI.toast('No se pudo compartir la pantalla.'); }
    }
  },

  _stopScreen() {
    if (!this._screenStream) return;
    try { this._screenStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    this._screenStream = null;
    let back = null;
    if (this._camTrack && this._camTrack.readyState === 'live') back = this._camTrack;
    else if (this._dummyTrack && this._dummyTrack.readyState === 'live') back = this._dummyTrack;
    else { this._dummyTrack = this._makeDummyVideo(); back = this._dummyTrack; }
    this._replaceVideoTrack(back);
    const lv = $('#localVideo');
    if (lv && this.localStream) { try { lv.srcObject = this.localStream; lv.play().catch(() => {}); } catch (e) {} }
    const ov = $('#callOverlay');
    if (ov) ov.classList.remove('local-screen');
    const btn = $('#callControls [data-act="screen"]');
    if (btn) btn.classList.remove('toggled');
    this._broadcastMedia();
    this._pipSyncControls();
    this._pipSyncMedia();
    if (this.mode === 'group' && this.state === 'active') this._renderTiles();
    UI.toast('Dejaste de compartir la pantalla.');
  },

  /* sustituir la pista de video en el stream local y en todas las conexiones */
  _replaceVideoTrack(track) {
    if (!track) return;
    if (this.localStream) {
      const old = this.localStream.getVideoTracks()[0];
      if (old && old !== track) { try { this.localStream.removeTrack(old); } catch (e) {} }
      if (!this.localStream.getVideoTracks().includes(track)) this.localStream.addTrack(track);
    }
    Object.values(this.conns).forEach((c) => {
      try {
        const pc = c.peerConnection;
        if (!pc) return;
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video')
          || pc.getSenders().find((s) => !s.track);
        if (sender && sender.replaceTrack) sender.replaceTrack(track);
      } catch (e) { console.warn('replaceTrack', e); }
    });
  },

  /* ================== segundo plano (PiP multi-pestaña / banner) ================== */
  _canPip() { return typeof window !== 'undefined' && 'documentPictureInPicture' in window; },

  minimize() {
    if (this.state === 'idle' || this.state === 'in') return;
    this._minimized = true;
    const ov = $('#callOverlay');
    if (ov) ov.hidden = true;
    if (this._canPip()) {
      /* ventana flotante SIEMPRE VISIBLE: persiste al cambiar de pestaña
         o de aplicación (Document Picture-in-Picture) */
      this.openPip().then((ok) => { if (!ok) this._showBanner(); });
    } else {
      this._showBanner();
    }
    this._tick();
    if (typeof App !== 'undefined') App.updateTitle();
  },

  _showBanner() {
    const b = $('#callBanner');
    if (!b) return;
    const name = this.displayName();
    $('#cbName').textContent = name;
    const av = $('#cbAvatar');
    if (this.mode === 'group' && this.g) {
      av.innerHTML = `<span class="g-mark"><svg class="icon"><use href="#i-users"/></svg></span>`;
      avatarStyle(av, this.g.gid);
    } else if (this.meta) {
      av.innerHTML = Avatars.html(this.meta.from, name);
      avatarStyle(av, this.meta.from);
    }
    $('#cbState').textContent = this.state === 'active' ? 'En llamada' : 'Conectando…';
    b.hidden = false;
  },

  restore() {
    this._minimized = false;
    const b = $('#callBanner');
    if (b) b.hidden = true;
    this._closePip();
    if (this.state !== 'idle') { const ov = $('#callOverlay'); if (ov) ov.hidden = false; }
  },

  /* ---------- ventana flotante (Document Picture-in-Picture) ---------- */
  async openPip() {
    if (this.state === 'idle') return false;
    if (this._pipWin) { try { this._pipWin.focus(); } catch (e) {} return true; }
    if (!this._canPip()) return false;
    try {
      const win = await documentPictureInPicture.requestWindow({ width: 330, height: 480 });
      this._pipWin = win;
      this._buildPip(win);
      win.addEventListener('pagehide', () => this._onPipClosed());
      this._tick();
      return true;
    } catch (e) {
      console.warn('[pip]', e);
      this._pipWin = null;
      this._pipEls = null;
      return false;
    }
  },

  _buildPip(win) {
    const doc = win.document;
    doc.title = 'Nexo · llamada';
    const isGroup = this.mode === 'group';
    const name = this.displayName() || 'Llamada';
    const hue = hueOf(isGroup ? (this.g && this.g.gid) : (this.meta && this.meta.from));
    const avatarInner = isGroup
      ? `<span class="g-mark"><svg class="ic"><use href="#i-users"/></svg></span>`
      : Avatars.html(this.meta.from, name);

    const style = doc.createElement('style');
    style.textContent = this._pipCSS();
    doc.head.appendChild(style);

    /* copiar el sprite de iconos de la app al documento flotante */
    const sprite = document.getElementById('svgSprite');
    if (sprite) doc.body.appendChild(sprite.cloneNode(true));

    doc.body.insertAdjacentHTML('beforeend', `
      <div class="pip-call">
        <div class="pip-head">
          <div class="pip-av" style="--h:${hue}">${avatarInner}</div>
          <div class="pip-info"><strong>${esc(name)}</strong><span class="pip-state">Conectando…</span></div>
        </div>
        <div class="pip-stage">
          <video class="pip-video" autoplay playsinline></video>
          <div class="pip-bigav" style="--h:${hue}">${avatarInner}</div>
          <div class="pip-grp" ${isGroup ? '' : 'hidden'}></div>
        </div>
        <div class="pip-ctrls">
          <button data-p="mic" title="Silenciar micrófono"><svg class="ic"><use href="#i-mic"/></svg></button>
          <button data-p="cam" title="Cámara"><svg class="ic"><use href="#i-video"/></svg></button>
          <button data-p="screen" title="Compartir pantalla"><svg class="ic"><use href="#i-monitor"/></svg></button>
          <button data-p="expand" title="Volver a Nexo"><svg class="ic"><use href="#i-up"/></svg></button>
          <button data-p="hangup" class="h" title="Colgar"><svg class="ic"><use href="#i-phone"/></svg></button>
        </div>
      </div>`);

    this._pipEls = {
      state: doc.querySelector('.pip-state'),
      video: doc.querySelector('.pip-video'),
      bigav: doc.querySelector('.pip-bigav'),
      grp: doc.querySelector('.pip-grp'),
      btns: {
        mic: doc.querySelector('[data-p="mic"]'),
        cam: doc.querySelector('[data-p="cam"]'),
        screen: doc.querySelector('[data-p="screen"]')
      }
    };

    /* visibilidad inicial del escenario según modo */
    this._pipVideoOn = false;
    this._pipEls.video.style.display = 'none';
    this._pipEls.bigav.style.display = isGroup ? 'none' : 'grid';

    doc.querySelector('.pip-ctrls').addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      const a = b.dataset.p;
      if (a === 'mic') this.toggleMic();
      else if (a === 'cam') this.toggleCam();
      else if (a === 'screen') this.toggleScreen();
      else if (a === 'hangup') this.hangup();
      else if (a === 'expand') {
        this.restore();
        try { window.focus(); } catch (err) {}
      }
    });

    if (isGroup) this._pipRenderGrp();
    this._pipSyncMedia();
    this._pipSyncControls();
  },

  _pipCSS() {
    return `
      *{box-sizing:border-box;margin:0;padding:0}
      [hidden]{display:none!important}
      html,body{height:100%;overflow:hidden}
      body{font-family:Inter,system-ui,-apple-system,sans-serif;color:#fff;
        background:linear-gradient(165deg,#141b24,#0a0f14);-webkit-user-select:none;user-select:none}
      .pip-call{display:flex;flex-direction:column;height:100%}
      .pip-head{display:flex;align-items:center;gap:9px;padding:10px 12px 6px}
      .pip-av{width:34px;height:34px;border-radius:50%;flex:none;display:grid;place-items:center;
        font-size:12px;font-weight:700;background:hsl(var(--h,170) 45% 36%);overflow:hidden}
      .pip-av img{width:100%;height:100%;object-fit:cover}
      .pip-av .ic{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2}
      .pip-info{min-width:0;display:grid}
      .pip-info strong{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pip-info span{font-size:11px;color:#5eead4;font-weight:600;font-variant-numeric:tabular-nums}
      .pip-stage{flex:1;position:relative;margin:4px 10px;border-radius:14px;background:#04080b;
        overflow:hidden;display:grid;place-items:center}
      .pip-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
      .pip-bigav{width:92px;height:92px;border-radius:50%;display:grid;place-items:center;
        font-size:30px;font-weight:800;background:hsl(var(--h,170) 45% 36%);overflow:hidden;
        box-shadow:0 0 0 6px rgba(94,234,212,.12)}
      .pip-bigav img{width:100%;height:100%;object-fit:cover}
      .pip-grp{width:100%;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:14px;
        align-content:center;max-height:100%;overflow:auto}
      .pg-av{position:relative;aspect-ratio:1;border-radius:50%;display:grid;place-items:center;
        font-size:15px;font-weight:700;background:hsl(var(--h,170) 40% 30%);overflow:hidden;opacity:.45}
      .pg-av.on{opacity:1;box-shadow:0 0 0 2.5px #2dd4bf}
      .pg-av img{width:100%;height:100%;object-fit:cover}
      .pip-ctrls{display:flex;justify-content:center;gap:10px;padding:12px}
      .pip-ctrls button{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;
        background:rgba(255,255,255,.13);color:#fff;border:1px solid rgba(255,255,255,.16);
        cursor:pointer;transition:transform .12s,background .12s}
      .pip-ctrls button:hover{background:rgba(255,255,255,.26);transform:scale(1.07)}
      .pip-ctrls button.toggled{background:rgba(255,255,255,.88);color:#111}
      .pip-ctrls button.h{background:#e11d48;border-color:transparent}
      .pip-ctrls button.h:hover{background:#f43f5e}
      .pip-ctrls .ic{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;
        stroke-linecap:round;stroke-linejoin:round}
      .pip-ctrls button.h .ic{transform:rotate(135deg)}
      button{font-family:inherit}`;
  },

  /* el usuario cerró la ventanita manualmente */
  _onPipClosed() {
    this._pipWin = null;
    this._pipEls = null;
    this._pipVideoOn = false;
    if (this._pipClosing || this.state === 'idle') return;
    /* seguir en segundo plano: volver a la app si está a la vista;
       si no, dejar el banner interno como indicador */
    if (!document.hidden) {
      this._minimized = false;
      const ov = $('#callOverlay');
      if (ov) ov.hidden = false;
    } else {
      this._showBanner();
    }
  },

  _closePip() {
    if (!this._pipWin) return;
    this._pipClosing = true;
    try { this._pipWin.close(); } catch (e) {}
    this._pipWin = null;
    this._pipEls = null;
    this._pipVideoOn = false;
    setTimeout(() => { this._pipClosing = false; }, 300);
  },

  /* ---------- reflejar el estado de la llamada en el PiP ---------- */
  _pipRenderGrp() {
    if (!this._pipEls || !this._pipEls.grp || this.mode !== 'group') return;
    const me = Auth.me.uid;
    const others = [...new Set([...((this.g && this.g.members) || []), ...Object.keys(this.streams)])]
      .filter((u) => u !== me);
    const items = [['Tú', me, true], ...others.map((u) => [Friends.name(u) || u, u, !!this.streams[u]])];
    this._pipEls.grp.innerHTML = items.map(([nm, u, on]) => `
      <div class="pg-av ${on ? 'on' : ''}" style="--h:${hueOf(u)}" title="${esc(nm)}">${Avatars.html(u, nm)}</div>`).join('');
  },

  _pipSyncMedia() {
    if (!this._pipEls) return;
    if (this.mode === 'p2p' && this.meta) {
      const uid = this.meta.from;
      const md = this.media[uid] || {};
      const vid = md.vid || (this._video ? 'cam' : 'none');
      const wantVideo = (vid === 'cam' || vid === 'screen') && !!this.streams[uid] && this.state === 'active';
      if (wantVideo !== this._pipVideoOn) {
        this._pipVideoOn = wantVideo;
        const v = this._pipEls.video;
        const av = this._pipEls.bigav;
        if (wantVideo) {
          try { v.srcObject = this.streams[uid]; v.play().catch(() => {}); } catch (e) {}
          v.style.display = 'block';
          av.style.display = 'none';
        } else {
          try { v.srcObject = null; } catch (e) {}
          v.style.display = 'none';
          av.style.display = 'grid';
        }
      }
    }
  },

  _pipSyncControls() {
    if (!this._pipEls || !this._pipEls.btns) return;
    const { mic, cam, screen } = this._pipEls.btns;
    const micOn = !!(this._audioTrack && this._audioTrack.enabled);
    if (mic) {
      mic.classList.toggle('toggled', !micOn);
      mic.querySelector('use').setAttribute('href', micOn ? '#i-mic' : '#i-mic-off');
    }
    const camOn = !!this._camTrack && this._camTrack.enabled && !this._screenStream;
    if (cam) {
      cam.classList.toggle('toggled', !camOn);
      cam.querySelector('use').setAttribute('href', camOn ? '#i-video' : '#i-cam-off');
    }
    if (screen) screen.classList.toggle('toggled', !!this._screenStream);
  },

  /* ---------- Media Session: llamada como medios del sistema ---------- */
  _setMediaSession() {
    if (!('mediaSession' in navigator) || this._msSet) return;
    try {
      const name = this.displayName() || 'Nexo';
      navigator.mediaSession.metadata = new MediaMetadata({
        title: (this.mode === 'group' ? 'Llamada de grupo · ' : 'Llamada con ') + name,
        artist: 'Nexo',
        album: this.mode === 'group' ? 'Llamada grupal' : 'Llamada de voz y video'
      });
      navigator.mediaSession.playbackState = 'playing';
      const acts = {
        hangup: () => this.hangup(),
        stop: () => this.hangup(),
        togglemicrophone: () => this.toggleMic(),
        togglecamera: () => this.toggleCam()
      };
      Object.entries(acts).forEach(([k, fn]) => {
        try { navigator.mediaSession.setActionHandler(k, fn); } catch (e) {}
      });
      this._msSet = true;
    } catch (e) {}
  },

  _clearMediaSession() {
    if (!this._msSet) return;
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      ['hangup', 'stop', 'togglemicrophone', 'togglecamera'].forEach((k) => {
        try { navigator.mediaSession.setActionHandler(k, null); } catch (e) {}
      });
    } catch (e) {}
    this._msSet = false;
  },

  /* ================== audio persistente ================== */
  _attachAudio(uid, stream) {
    if (!stream) return;
    const box = $('#callAudioBox');
    if (!box) return;
    let a = box.querySelector(`audio[data-auid="${CSS.escape(uid)}"]`);
    if (!a) {
      a = document.createElement('audio');
      a.dataset.auid = uid;
      a.autoplay = true;
      a.setAttribute('playsinline', '');
      box.appendChild(a);
    }
    try { a.srcObject = stream; a.play().catch(() => {}); } catch (e) {}
  },
  _detachAudio(uid) {
    const a = document.querySelector(`#callAudioBox audio[data-auid="${CSS.escape(uid)}"]`);
    if (a) { try { a.srcObject = null; a.remove(); } catch (e) {} }
  },
  _detachAllAudio() {
    const box = $('#callAudioBox');
    if (box) box.innerHTML = '';
  },

  /* ================== cronómetro ================== */
  _startTimer() {
    this._t0 = Date.now();
    clearInterval(this._durTimer);
    this._durTimer = setInterval(() => this._tick(), 1000);
    this._tick();
  },
  _tick() {
    const s = Math.max(0, Math.floor((Date.now() - this._t0) / 1000));
    const txt = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const el = $('#callTimer');
    if (el && this.state === 'active') { el.hidden = false; el.textContent = txt; }
    if (this.mode === 'group' && this.state === 'active') {
      const st2 = $('#callState');
      if (st2) {
        const n = Object.keys(this.streams).length + 1;
        st2.textContent = `En llamada · ${n} ${n === 1 ? 'participante' : 'participantes'} · ${txt}`;
      }
    }
    const cb = $('#cbState');
    if (cb && this._minimized && !this._pipWin) {
      cb.textContent = this.state === 'active'
        ? `En llamada · ${txt}`
        : (this.mode === 'group' ? 'Uniéndose al grupo…' : 'Conectando…');
    }
    /* ventana flotante PiP */
    if (this._pipWin && this._pipEls) {
      const st = this._pipEls.state;
      if (st) {
        if (this.state === 'active') {
          if (this.mode === 'group') {
            const n = Object.keys(this.streams).length + 1;
            st.textContent = `${n} ${n === 1 ? 'participante' : 'participantes'} · ${txt}`;
          } else st.textContent = `En llamada · ${txt}`;
        } else st.textContent = this.mode === 'group' ? 'Uniéndose…' : 'Conectando…';
      }
      this._pipSyncMedia();
      /* refrescar los avatares del grupo solo si cambió el conjunto */
      if (this.mode === 'group' && this.g) {
        const sig = [...new Set([...(this.g.members || []), ...Object.keys(this.streams)])].sort().join(',');
        if (sig !== this._pipGrpSig) {
          this._pipGrpSig = sig;
          this._pipRenderGrp();
        }
      }
    }
  },

  /* ================== overlay ================== */
  showOverlay(st, name, remoteStream) {
    const ov = $('#callOverlay');
    if (!this._minimized) ov.hidden = false;
    ov.classList.toggle('ring', st === 'in' || st === 'out');
    const grpMode = this.mode === 'group';

    /* Media Session: la llamada aparece como medios del sistema
       (audio continúa y hay controles al cambiar de pestaña/app) */
    if (st !== 'in') this._setMediaSession();

    /* p2p: video remoto */
    const rv = $('#remoteVideo');
    const lv = $('#localVideo');
    const remote = remoteStream || (grpMode ? null : (this.meta && this.streams[this.meta.from]));
    if (!grpMode) {
      if (remote) { try { rv.srcObject = remote; } catch (e) {} rv.play().catch(() => {}); }
      else { try { rv.srcObject = null; } catch (e) {} }
    } else { try { rv.srcObject = null; } catch (e) {} }

    if (this.localStream && !this._screenStream) {
      try { lv.srcObject = this.localStream; } catch (e) {}
      lv.play().catch(() => {});
    } else if (this._screenStream) {
      try { lv.srcObject = this._screenStream; } catch (e) {}
      lv.play().catch(() => {});
    }

    const md = !grpMode && this.meta ? this.media[this.meta.from] : null;
    const remoteVid = md ? md.vid : (this._video ? 'cam' : 'none');
    const realRemote = !grpMode && (remoteVid === 'cam' || remoteVid === 'screen');
    ov.classList.toggle('video-active', st === 'active' && realRemote);
    ov.classList.toggle('screen-share', st === 'active' && realRemote && remoteVid === 'screen');
    lv.style.visibility = (st === 'active' || st === 'connecting' || st === 'out') && (this._camTrack || this._screenStream) ? 'visible' : 'hidden';

    /* cabecera central */
    const av = $('#callAvatar');
    if (grpMode) {
      av.innerHTML = `<span class="g-mark"><svg class="icon"><use href="#i-users"/></svg></span>`;
      avatarStyle(av, this.g.gid);
    } else {
      const avUid = (this.meta && this.meta.from) || name || 'n';
      av.innerHTML = Avatars.html(avUid, name || '?');
      avatarStyle(av, avUid);
    }
    $('#callName').textContent = name || '';

    let txt = { out: 'Llamando…', in: 'Llamada entrante', connecting: 'Conectando…', active: 'En llamada' }[st] || '';
    if (grpMode) {
      if (st === 'out') txt = 'Llamando al grupo…';
      else if (st === 'in') txt = `Llamada de grupo · ${this._invite ? (this._invite.fromName || '') : ''}`;
      else if (st === 'connecting') txt = 'Uniéndose…';
      else if (st === 'active') {
        const n = Object.keys(this.streams).length + 1;
        txt = `En llamada · ${n} ${n === 1 ? 'participante' : 'participantes'}`;
      }
    }
    $('#callState').textContent = this._video && st !== 'active' ? `${txt} · video` : txt;

    const timer = $('#callTimer');
    timer.hidden = st !== 'active';
    if (st === 'active') timer.textContent = '00:00';

    /* centro vs tiles */
    const center = $('#callCenter');
    const tiles = $('#callTiles');
    const grpMembers = $('#callGrpMembers');
    const showTiles = grpMode && st === 'active';
    ov.classList.toggle('group-active', showTiles);
    center.hidden = false; /* en group-active se compacta arriba vía CSS */
    tiles.hidden = !showTiles;
    grpMembers.hidden = !(grpMode && (st === 'in' || st === 'out' || st === 'connecting'));

    if (grpMode && st !== 'active') this._renderGrpMembers();
    if (showTiles) this._renderTiles();
    if (this._pipWin) {
      this._pipRenderGrp();
      this._pipSyncMedia();
      this._pipSyncControls();
    }

    this.renderControls(st);
  },

  _renderGrpMembers() {
    const row = $('#callGrpMembers');
    if (!row || !this.g) return;
    const others = [...new Set([...(this.g.members || []), ...Object.keys(this.streams)])].filter((u) => u !== Auth.me.uid);
    row.innerHTML = others.map((u) => {
      const on = !!this.streams[u];
      const nm = u === (this.g && this.g.inviter) ? `${Friends.name(u)} · anfitrión` : Friends.name(u);
      return `<span class="gm-av avatar ${on ? 'on' : ''}" style="--h:${hueOf(u)}" title="${esc(nm)}">${Avatars.html(u, Friends.name(u))}</span>`;
    }).join('');
  },

  _renderTiles() {
    if (this.mode !== 'group' || !this.g) return;
    const box = $('#callTiles');
    if (!box) return;
    const me = Auth.me.uid;
    const others = [...new Set([...(this.g.members || []), ...Object.keys(this.conns), ...Object.keys(this.streams)])].filter((u) => u !== me);
    const all = [me, ...others];
    box.innerHTML = all.map((u) => {
      const connected = u === me ? true : !!this.streams[u];
      const md = u === me ? {} : (this.media[u] || {});
      const vid = u === me
        ? (this._screenStream ? 'screen' : (this._camTrack ? 'cam' : 'none'))
        : (md.vid || 'none');
      const micOff = u === me ? (this._audioTrack && !this._audioTrack.enabled) : (md.mic === false);
      const nm = u === me ? 'Tú' : (Friends.name(u) || u);
      const hasVideo = vid === 'cam' || vid === 'screen';
      return `<div class="tile ${connected ? 'on' : 'wait'} ${hasVideo ? 'has-video' : ''} ${vid === 'screen' ? 'sharing' : ''}" data-tuid="${esc(u)}">
        <video autoplay playsinline ${u === me ? 'muted' : ''} data-tv="${esc(u)}"></video>
        <div class="t-av avatar" style="--h:${hueOf(u)}">${Avatars.html(u, u === me ? Auth.me.name : (Friends.name(u) || u))}</div>
        <div class="t-tag">
          <span class="t-name">${esc(nm)}</span>
          ${micOff ? '<svg class="icon t-micoff"><use href="#i-mic-off"/></svg>' : ''}
          ${vid === 'screen' ? '<span class="t-scr">· pantalla</span>' : ''}
        </div>
        ${connected ? '' : '<span class="t-wait">conectando…</span>'}
      </div>`;
    }).join('');

    all.forEach((u) => {
      const v = box.querySelector(`video[data-tv="${CSS.escape(u)}"]`);
      if (!v) return;
      const st = u === me ? (this._screenStream || this.localStream) : this.streams[u];
      if (st) { try { if (v.srcObject !== st) { v.srcObject = st; v.play().catch(() => {}); } } catch (e) {} }
    });
  },

  _applyRemoteVideo(vid) {
    if (this.mode !== 'p2p') return;
    const ov = $('#callOverlay');
    if (!ov) return;
    const real = vid === 'cam' || vid === 'screen';
    ov.classList.toggle('video-active', real && this.state === 'active');
    ov.classList.toggle('screen-share', vid === 'screen');
    const el = $('#callState');
    if (el && this.state === 'active') {
      const name = this.meta ? this.meta.name : '';
      el.textContent = vid === 'screen' ? `${name} comparte su pantalla` : 'En llamada';
    }
  },

  renderControls(st) {
    const c = $('#callControls');
    const micBtn = () => `<button class="call-btn" data-act="mic" title="Silenciar micrófono"><svg class="icon"><use href="#i-mic"/></svg></button>`;
    const camBtn = () => `<button class="call-btn" data-act="cam" title="Cámara"><svg class="icon"><use href="#i-video"/></svg></button>`;
    const screenBtn = () => `<button class="call-btn ${this._screenStream ? 'toggled' : ''}" data-act="screen" title="Compartir pantalla"><svg class="icon"><use href="#i-monitor"/></svg></button>`;
    const minBtn = () => `<button class="call-btn" data-act="minimize" title="${this._canPip() ? 'Ventana flotante (visible en otras pestañas y apps)' : 'Seguir en segundo plano'}"><svg class="icon"><use href="#i-chev-down"/></svg></button>`;
    const hangBtn = () => `<button class="call-btn hangup" data-act="hangup" title="Colgar"><svg class="icon"><use href="#i-phone"/></svg></button>`;

    if (st === 'out' || st === 'connecting') c.innerHTML = minBtn() + hangBtn();
    else if (st === 'in') c.innerHTML = `<button class="call-btn hangup" data-act="decline" title="Rechazar"><svg class="icon"><use href="#i-phone"/></svg></button>
      <button class="call-btn answer" data-act="accept" title="Responder"><svg class="icon"><use href="#i-phone"/></svg></button>`;
    else if (st === 'active') c.innerHTML = micBtn() + camBtn() + screenBtn() + minBtn() + hangBtn();
    else c.innerHTML = '';
  },

  hideOverlay() {
    const ov = $('#callOverlay');
    if (!ov) return;
    ov.hidden = true;
    ov.classList.remove('ring', 'video-active', 'screen-share', 'local-screen', 'group-active');
    try {
      $('#remoteVideo').srcObject = null;
      $('#localVideo').srcObject = null;
    } catch (e) {}
    $('#callTimer').hidden = true;
    $('#callControls').innerHTML = '';
  }
};
