/* profile.js — ver el perfil de cualquier usuario
   - Modal con foto grande, nombre, @usuario, estado (en línea / última
     conexión), "acerca de" (bio) y acciones según relación:
     chatear · llamar · videollamada · añadir / eliminar amigo.
   - Se abre desde: cabecera del chat (DM), avatar/nombre del autor de
     cada mensaje de grupo, lista de amigos, miembros de un grupo y tu
     propio avatar del lateral.
   - Los datos frescos (nombre + foto + bio) se recuperan del perfil
     retenido en MQTT al abrir; mientras llega se muestran los cached.  */
'use strict';

const ProfileCard = {

  /* ================== abrir el perfil de un uid ================== */
  open(uid) {
    if (!Auth.me || !uid) return;
    const me = uid === Auth.me.uid;
    const local = this._localData(uid, me);
    this._render(uid, me, local);
    /* datos frescos del perfil retenido (bio incluida) */
    Mqtt.fetchRetained(T.profile(uid), 2600).then((p) => {
      if (!p || !p.uid) return;
      const fresh = {
        name: p.name || local.name,
        bio: p.bio || '',
        av: p.av || null
      };
      if (p.av) { Avatars.set(uid, p.av); }
      else if (p.av === '') { Avatars.remove(uid); }
      /* si el modal sigue abierto para este uid, refrescarlo */
      if (this._openUid === uid) this._render(uid, me, { ...local, ...fresh });
    }).catch(() => {});
  },

  /* datos disponibles localmente (instantáneos) */
  _localData(uid, me) {
    if (me) {
      return { name: Auth.me.name, bio: (Auth.me && Auth.me.bio) || '', av: Auth.me.av || null };
    }
    const f = Friends.friend(uid);
    return {
      name: f ? f.name : uid,
      bio: (f && f.bio) || '',
      av: Avatars.get(uid) ? Avatars.get(uid).av : null
    };
  },

  /* ================== render del modal ================== */
  _render(uid, me, d) {
    this._openUid = uid;
    const root = $('#modalRoot');
    if (!root) return;

    const name = d.name || uid;
    const online = me ? true : Presence.isOnline(uid);
    const status = me ? 'esto eres tú' : (online ? 'en línea' : (Presence.lastSeenTxt ? Presence.lastSeenTxt(uid) : 'desconectado'));
    const f = me ? null : Friends.friend(uid);
    const isFriend = !me && !!f;
    const commonGroups = me ? [] : Groups.all().filter((g) => (g.members || []).includes(uid));

    const avatarHTML = d.av
      ? `<img src="${esc(d.av)}" alt="">`
      : esc(initials(name));

    /* acciones según relación */
    let actions = '';
    if (me) {
      actions = `
        <button class="f-btn chat" data-pact="edit"><svg class="icon"><use href="#i-sliders"/></svg>Editar mi perfil</button>`;
    } else if (isFriend) {
      actions = `
        <button class="f-btn chat" data-pact="chat"><svg class="icon"><use href="#i-chat"/></svg>Chatear</button>
        <button class="f-btn chat" data-pact="call" title="Llamada de voz"><svg class="icon"><use href="#i-phone"/></svg></button>
        <button class="f-btn chat" data-pact="video" title="Videollamada"><svg class="icon"><use href="#i-video"/></svg></button>
        <button class="f-btn reject" data-pact="remove" title="Eliminar amigo"><svg class="icon"><use href="#i-user-minus"/></svg></button>`;
    } else {
      actions = `
        <button class="f-btn add" data-pact="add"><svg class="icon"><use href="#i-user-plus"/></svg>Añadir amigo</button>`;
    }

    root.innerHTML = `
      <div class="modal profile-modal">
        <div class="pf-cover" style="--h:${hueOf(uid)}">
          <button class="pf-close icon-btn" data-pact="close" title="Cerrar"><svg class="icon"><use href="#i-x"/></svg></button>
        </div>
        <div class="pf-body">
          <div class="avatar big pf-avatar ${online ? 'on' : ''}" style="--h:${hueOf(uid)}">${avatarHTML}</div>
          <h3 class="pf-name">${esc(name)}</h3>
          <p class="pf-user">@${esc(uid)}</p>
          <p class="pf-status ${online ? 'on' : ''}"><span class="pres-dot ${online ? 'on' : ''}"></span>${esc(status)}</p>
          ${d.bio ? `<div class="pf-bio"><small>Acerca de</small><p>${esc(d.bio)}</p></div>` : ''}
          ${isFriend && f.since ? `<p class="pf-since"><svg class="icon"><use href="#i-user-check"/></svg>Amigos desde ${esc(fmtDayLong(f.since))}</p>` : ''}
          ${!me && !isFriend && commonGroups.length ? `<p class="pf-groups"><svg class="icon"><use href="#i-users"/></svg>${commonGroups.length === 1 ? `Compartes el grupo «${esc(commonGroups[0].name)}»` : `Comparten ${commonGroups.length} grupos`}</p>` : ''}
          ${me && !d.bio ? `<p class="pf-hint">Añade una descripción en Ajustes para que tus amigos la vean aquí.</p>` : ''}
          <div class="pf-actions">${actions}</div>
        </div>
      </div>`;
    root.hidden = false;

    root.onclick = async (e) => {
      const b = e.target.closest('[data-pact]');
      if (!b) return;
      const act = b.dataset.pact;
      if (act === 'close') { this.close(); return; }
      if (act === 'edit') { this.close(); App.showView('settings'); return; }
      if (act === 'chat') { this.close(); App.openChat(uid); return; }
      if (act === 'call') { this.close(); Calls.start(uid, false); return; }
      if (act === 'video') { this.close(); Calls.start(uid, true); return; }
      if (act === 'add') {
        this.close();
        Friends.sendRequest({ uid, name: d.name || uid });
        return;
      }
      if (act === 'remove') {
        this.close();
        UI.confirm('Eliminar amigo', `¿Eliminar a ${esc(d.name || uid)}? Dejaréis de ser amigos.`, 'Eliminar', true)
          .then((ok) => { if (ok) Friends.removeFriend(uid); });
      }
    };
  },

  close() {
    this._openUid = null;
    const root = $('#modalRoot');
    if (!root) return;
    root.hidden = true;
    root.innerHTML = '';
    root.onclick = null;
  }
};
