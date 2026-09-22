/* games.js — apartado de Juegos
   - Tarjetas en el panel lateral con arte propio por juego
   - Escenario en la zona principal: el juego corre DENTRO de Nexo
     (iframe a pantalla casi completa) o se abre en pestaña nueva
   - Emergency Strike y Apex Kart (webs de googlesitecom)          */
'use strict';

const Games = {
  GAMES: [
    {
      id: 'emergency-strike',
      name: 'Emergency Strike',
      tag: 'Acción táctica',
      desc: 'Misión de combate en primera persona: apunta, cubre tu posición y elimina los objetivos antes de que el tiempo se agote.',
      url: 'https://googlesitecom.github.io/Googlecom/',
      cta: 'Entrar en misión'
    },
    {
      id: 'apex-kart',
      name: 'Apex Kart',
      tag: 'Carreras',
      desc: 'Pisa el acelerador y derrapa en circuitos a toda velocidad. Corre contra el reloj y baja tu mejor vuelta.',
      url: 'https://googlesitecom.github.io/gmail/',
      cta: 'Poner en marcha'
    }
  ],
  current: null,

  get(id) { return this.GAMES.find((g) => g.id === id) || null; },

  /* ---------- panel lateral ---------- */
  render() {
    const box = $('#viewGames');
    if (!box) return;
    box.innerHTML = `
      <p class="games-intro">Juega sin salir de Nexo: el juego se abre aquí mismo y tus chats siguen a un clic.</p>
      <div class="games-grid">
        ${this.GAMES.map((g) => this._card(g)).join('')}
      </div>
      <p class="games-note"><svg class="icon"><use href="#i-shield"/></svg>Los juegos se cargan desde su propia web (googlesitecom.github.io).</p>`;
  },

  _card(g) {
    return `
      <button class="game-card" data-game="${esc(g.id)}" title="Jugar a ${esc(g.name)}">
        <span class="game-art">${this._art(g.id)}</span>
        <span class="game-body">
          <strong>${esc(g.name)}</strong>
          <em>${esc(g.tag)}</em>
          <span class="game-desc">${esc(g.desc)}</span>
          <span class="game-cta">
            <svg class="icon"><use href="#i-play"/></svg>${esc(g.cta)}
          </span>
        </span>
      </button>`;
  },

  /* arte SVG por juego (autocontenido, sin dependencias) */
  _art(id) {
    if (id === 'emergency-strike') return `
      <svg viewBox="0 0 200 110" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <linearGradient id="ga1" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#3f1d24"/><stop offset="1" stop-color="#12070a"/>
          </linearGradient>
          <radialGradient id="ga1g" cx=".5" cy=".5" r=".5">
            <stop offset="0" stop-color="#f87171" stop-opacity=".9"/><stop offset="1" stop-color="#f87171" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="200" height="110" fill="url(#ga1)"/>
        <circle cx="100" cy="55" r="42" fill="url(#ga1g)" opacity=".35"/>
        <g stroke="#f87171" stroke-width="2.5" fill="none" opacity=".9">
          <circle cx="100" cy="55" r="26"/>
          <path d="M100 22v14M100 74v14M67 55h14M119 55h14"/>
        </g>
        <circle cx="100" cy="55" r="3.5" fill="#fca5a5"/>
        <g fill="#fb7185" opacity=".65">
          <rect x="14" y="12" width="26" height="5" rx="2.5"/>
          <rect x="8" y="24" width="38" height="5" rx="2.5"/>
          <rect x="160" y="82" width="30" height="5" rx="2.5"/>
          <rect x="168" y="70" width="22" height="5" rx="2.5"/>
        </g>
        <path d="M0 96c34-7 62-2 84 4s44 9 116-6v16H0z" fill="#000" opacity=".45"/>
      </svg>`;
    /* apex kart */
    return `
      <svg viewBox="0 0 200 110" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <linearGradient id="ga2" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#0c2340"/><stop offset="1" stop-color="#071120"/>
          </linearGradient>
          <linearGradient id="ga2r" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#22d3ee"/>
          </linearGradient>
        </defs>
        <rect width="200" height="110" fill="url(#ga2)"/>
        <g stroke="#38bdf8" stroke-width="3" opacity=".5" stroke-linecap="round">
          <path d="M10 26h58M4 44h44M18 62h70"/>
        </g>
        <g fill="#e2e8f0">
          <rect x="150" y="10" width="12" height="12"/><rect x="162" y="10" width="12" height="12" fill="#0f172a"/>
          <rect x="174" y="10" width="12" height="12"/><rect x="186" y="10" width="12" height="12" fill="#0f172a"/>
          <rect x="150" y="22" width="12" height="12" fill="#0f172a"/><rect x="162" y="22" width="12" height="12"/>
          <rect x="174" y="22" width="12" height="12" fill="#0f172a"/><rect x="186" y="22" width="12" height="12"/>
        </g>
        <g>
          <path d="M96 66c2-12 8-22 20-27l6 10c-8 3-13 9-15 17z" fill="url(#ga2r)"/>
          <path d="M112 40c10-4 22-2 30 5l-8 8c-5-4-12-6-18-3z" fill="#7dd3fc"/>
          <rect x="98" y="62" width="34" height="10" rx="5" fill="url(#ga2r)"/>
          <circle cx="104" cy="76" r="9" fill="#0f172a" stroke="#94a3b8" stroke-width="3"/>
          <circle cx="128" cy="76" r="9" fill="#0f172a" stroke="#94a3b8" stroke-width="3"/>
          <circle cx="104" cy="76" r="2.5" fill="#e2e8f0"/>
          <circle cx="128" cy="76" r="2.5" fill="#e2e8f0"/>
        </g>
        <path d="M0 96c34-7 62-2 84 4s44 9 116-6v16H0z" fill="#000" opacity=".5"/>
      </svg>`;
  },

  /* ---------- escenario principal (el juego corre dentro de Nexo) ---------- */
  open(id) {
    const g = this.get(id);
    if (!g) return;
    this.current = id;
    $('#gsName').textContent = g.name;
    $('#gsTag').textContent = g.tag;
    const ext = $('#gsExt');
    if (ext) ext.href = g.url;
    const fr = $('#gsFrame');
    if (fr) fr.src = g.url;
    $('#emptyState').hidden = true;
    $('#chatView').hidden = true;
    $('#gameStage').hidden = false;
    if (window.innerWidth <= 920) App.setChatOpen(true);
  },

  close() {
    if ($('#gameStage').hidden) return;
    this.current = null;
    const fr = $('#gsFrame');
    if (fr) { try { fr.src = 'about:blank'; } catch (e) {} } /* detener el juego */
    $('#gameStage').hidden = true;
    $('#emptyState').hidden = false;
  }
};
