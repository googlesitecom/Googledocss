/* groups.js — grupos de chat reales
   - Crear grupo eligiendo amigos; los invitados reciben una invitación
     retenida (les llega aunque estén desconectados) y se unen al abrir la app
   - Descriptor del grupo retenido en nexo/v1/group/<gid> (fuente de verdad)
   - Mensajes de grupo en nexo/v1/gm/<gid>/<autor>/<id> (retained + 7 días,
     misma bandeja offline que los DM) con chunks para imagen/voz
   - Salir del grupo notifica al resto; el historial vive por dispositivo  */
'use strict';

const Groups = {
  /* ---------- persistencia local ---------- */
  all() { return Auth.me ? LS.get(K.groups(Auth.me.uid), []) : []; },
  save(l) { if (Auth.me) LS.set(K.groups(Auth.me.uid), l); },
  get(gid) { return this.all().find((g) => g.id === gid) || null; },
  count() { return this.all().length; },

  subscribeAll() {
    Mqtt.sub(`${NS}/ginv/${Auth.me.uid}/+`);
    this.all().forEach((g) => {
      Mqtt.sub(`${NS}/gm/${g.id}/#`);
      /* reacciones de grupo (retenidas, expiran a los 7 días) */
      Mqtt.sub(`${NS}/grx/${g.id}/#`);
      /* descriptor retenido: nombre, miembros y FOTO del grupo en vivo */
      Mqtt.sub(T.group(g.id));
      /* estado de la llamada de grupo en curso (barra «Unirse») */
      Mqtt.sub(T.gcall(g.id));
      /* vigilar presencia/perfil de todos los miembros (aunque no sean amigos) */
      (g.members || []).forEach((u) => Presence.watch(u));
    });
  },

  /* ---------- crear ---------- */
  create(name, memberUids) {
    name = String(name || '').trim();
    if (name.length < 2 || name.length > 40) throw new Error('El nombre del grupo debe tener entre 2 y 40 caracteres.');
    memberUids = (memberUids || []).filter((u) => u && u !== Auth.me.uid && Friends.isFriend(u));
    if (!memberUids.length) throw new Error('Selecciona al menos un amigo para el grupo.');

    const g = {
      id: 'g' + rid(),
      name,
      creator: Auth.me.uid,
      members: [Auth.me.uid, ...memberUids],
      created: Date.now()
    };
    this.save([...this.all(), g]);

    /* descriptor retenido: cualquier miembro puede recuperarlo */
    this.publishDescriptor(g);
    Mqtt.sub(`${NS}/gm/${g.id}/#`);
    Mqtt.sub(`${NS}/grx/${g.id}/#`);
    Mqtt.sub(T.group(g.id));
    Mqtt.sub(T.gcall(g.id));

    /* invitación retenida a cada miembro + push si está desconectado */
    memberUids.forEach((u) => {
      Mqtt.publish(T.ginv(u, g.id), {
        gid: g.id, name: g.name, from: Auth.me.uid, fromName: Auth.me.name, ts: Date.now()
      }, { retain: true, expiry: 2592000 });
      Mqtt.publish(T.evt(u), { t: 'ginvite', gid: g.id, name: g.name, from: Auth.me.uid, fromName: Auth.me.name });
      if (!Presence.isOnline(u)) {
        Push.notify(u, 'Te añadieron a un grupo', `${Auth.me.name} te añadió al grupo «${g.name}»`, { chat: 'g:' + g.id });
      }
    });
    return g;
  },

  publishDescriptor(g) {
    Mqtt.publish(T.group(g.id), {
      id: g.id, name: g.name, creator: g.creator, members: g.members,
      av: GroupAvatars.get(g.id) || undefined,
      updated: Date.now()
    }, { retain: true, expiry: 15552000 }); /* 180 días */
  },

  /* ---------- descriptor recibido (retenido o en vivo):
     sincroniza nombre, miembros y FOTO del grupo ---------- */
  onDescriptor(gid, m) {
    if (!m || m.id !== gid || !Auth.me) return;
    const list = this.all();
    const mine = list.find((x) => x.id === gid);
    if (!mine) return; /* no soy miembro: ignorar */
    if (Array.isArray(m.members) && m.members.length && !m.members.includes(Auth.me.uid)) {
      /* me quitaron del grupo (descriptor actualizado sin mí) */
      list.splice(list.indexOf(mine), 1);
      this.save(list);
      Mqtt.unsub(`${NS}/gm/${gid}/#`);
      Mqtt.unsub(`${NS}/grx/${gid}/#`);
      Mqtt.unsub(T.group(gid));
      Mqtt.unsub(T.gcall(gid));
      GroupAvatars.remove(gid);
      if (Chat.active === 'g:' + gid) Chat.close();
      App.renderConvoList();
      UI.toast(`Te quitaron del grupo «${mine.name}».`);
      return;
    }
    let changed = false;
    if (m.name && m.name !== mine.name) { mine.name = m.name; changed = true; }
    if (Array.isArray(m.members)) {
      const a = [...m.members].sort().join(',');
      const b = [...(mine.members || [])].sort().join(',');
      if (a !== b) { mine.members = m.members; changed = true; }
    }
    if (typeof m.av === 'string') {
      const cur = GroupAvatars.get(gid);
      if (m.av && m.av !== cur) { GroupAvatars.set(gid, m.av); changed = true; }
      else if (!m.av && cur) { GroupAvatars.remove(gid); changed = true; }
    }
    if (m.creator) mine.creator = m.creator;
    if (changed) {
      this.save(list);
      App.renderConvoList();
      if (Chat.active === 'g:' + gid) Chat.renderHeaderInfo('g:' + gid);
    }
  },

  /* ---------- FOTO DEL GRUPO ---------- */
  async setPhoto(gid, file) {
    const g = this.get(gid);
    if (!g) throw new Error('Grupo no encontrado.');
    if (!file || !file.type.startsWith('image/')) throw new Error('Elige un archivo de imagen.');
    if (file.size > 12 * 1024 * 1024) throw new Error('La imagen supera 12 MB.');
    let dataURL = null;
    /* comprimir progresivamente (como los avatares de perfil) */
    for (const [dim, q] of [[192, 0.75], [160, 0.62], [128, 0.5]]) {
      const { b64 } = await compressImage(file, dim, q);
      dataURL = `data:image/jpeg;base64,${b64}`;
      if (b64.length <= 60000) break;
    }
    if (!dataURL) throw new Error('No se pudo procesar la imagen.');
    GroupAvatars.set(gid, dataURL);
    const list = this.all();
    const idx = list.findIndex((x) => x.id === gid);
    if (idx >= 0) { list[idx] = { ...list[idx], av: dataURL }; this.save(list); }
    /* descriptor retenido → todos los miembros la ven al instante */
    this.publishDescriptor(g);
    App.renderConvoList();
    if (Chat.active === 'g:' + gid) Chat.renderHeaderInfo('g:' + gid);
    UI.toast('Foto del grupo actualizada: todos los miembros la verán al instante.');
  },

  async removePhoto(gid) {
    const g = this.get(gid);
    if (!g) return;
    GroupAvatars.remove(gid);
    const list = this.all();
    const idx = list.findIndex((x) => x.id === gid);
    if (idx >= 0) { const { av, ...rest } = list[idx]; list[idx] = rest; this.save(list); }
    this.publishDescriptor(g);
    App.renderConvoList();
    if (Chat.active === 'g:' + gid) Chat.renderHeaderInfo('g:' + gid);
    UI.toast('Foto del grupo eliminada.');
  },

  /* ---------- invitación retenida recibida ---------- */
  onInvite(gid, m) {
    if (!m || !m.gid) return;
    if (this.get(gid)) { this.clearInvite(gid); return; }
    const g = {
      id: gid,
      name: m.name || 'Grupo',
      creator: m.from,
      members: [Auth.me.uid, m.from].filter((v, i, a) => a.indexOf(v) === i),
      created: m.ts || Date.now(),
      invitedBy: m.from
    };
    this.save([...this.all(), g]);
    Mqtt.sub(`${NS}/gm/${gid}/#`);
    Mqtt.sub(`${NS}/grx/${gid}/#`);
    Mqtt.sub(T.group(gid));
    Mqtt.sub(T.gcall(gid));
    Presence.watch(m.from);
    this.clearInvite(gid);
    /* refrescar miembros y FOTO desde el descriptor retenido (best effort) */
    Mqtt.fetchRetained(T.group(gid), 2000).then((d) => {
      if (d && Array.isArray(d.members) && d.members.includes(Auth.me.uid)) {
        const list = this.all();
        const mine = list.find((x) => x.id === gid);
        if (mine) {
          mine.members = d.members;
          mine.name = d.name || mine.name;
          if (d.av) GroupAvatars.set(gid, d.av);
          this.save(list);
          App.renderConvoList();
        }
      }
    }).catch(() => {});

    Notify.onGroupInvite({ gid, from: m.from, fromName: m.fromName || m.from, name: m.name || 'Grupo' });
    App.renderConvoList();
    if (Settings.sound) Sound.chime();
  },

  clearInvite(gid) {
    Mqtt.publish(T.ginv(Auth.me.uid, gid), '', { retain: true });
  },

  /* ---------- salir ---------- */
  leave(gid) {
    const g = this.get(gid);
    if (!g) return;
    const rest = g.members.filter((u) => u !== Auth.me.uid);
    const list = this.all().filter((x) => x.id !== gid);
    this.save(list);
    Mqtt.unsub(`${NS}/gm/${gid}/#`);
    Mqtt.unsub(`${NS}/grx/${gid}/#`);
    Mqtt.unsub(T.group(gid));
    Mqtt.unsub(T.gcall(gid));
    /* sin miembro: limpiar el estado de «llamada en curso» si lo había */
    if (typeof Calls !== 'undefined' && Calls.ongoing) delete Calls.ongoing[gid];

    if (rest.length) {
      const updated = { ...g, members: rest };
      this.publishDescriptor(updated);
      rest.forEach((u) => Mqtt.publish(T.evt(u), { t: 'gleft', gid, from: Auth.me.uid, fromName: Auth.me.name }));
    } else {
      /* era el último: limpiar el descriptor retenido */
      Mqtt.publish(T.group(gid), '', { retain: true });
    }
    if (Chat.active === 'g:' + gid) Chat.close();
    App.renderConvoList();
    UI.toast(`Saliste del grupo «${g.name}».`);
  },

  /* ---------- un miembro salió (evento en vivo) ---------- */
  onMemberLeft(m) {
    if (!m || !m.gid) return;
    const list = this.all();
    const g = list.find((x) => x.id === m.gid);
    if (!g) return;
    g.members = (g.members || []).filter((u) => u !== m.from);
    this.save(list);
    App.renderConvoList();
    if (Chat.active === 'g:' + m.gid) Chat.renderHeaderInfo('g:' + m.gid);
    UI.toast(`${m.fromName || m.from} salió del grupo «${g.name}».`);
  },

  /* ---------- helpers ---------- */
  name(gid) { const g = this.get(gid); return g ? g.name : 'Grupo'; },
  membersOf(gid) { const g = this.get(gid); return (g && g.members) || []; },
  onlineCount(gid) {
    return this.membersOf(gid).filter((u) => u !== Auth.me.uid && Presence.isOnline(u)).length;
  },
  memberNames(gid, max = 4) {
    return this.membersOf(gid)
      .filter((u) => u !== Auth.me.uid)
      .slice(0, max)
      .map((u) => Friends.name(u));
  },

  /* ---------- modal: crear grupo ---------- */
  openCreateModal() {
    const friends = Friends.all();
    if (!friends.length) { UI.toast('Añade amigos antes de crear un grupo.'); return; }
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal group-modal">
        <h3>Nuevo grupo</h3>
        <p>Elige un nombre y selecciona a tus amigos. Recibirán una invitación al instante.</p>
        <input id="grpName" class="set-input" maxlength="40" placeholder="Nombre del grupo (ej. Equipo de trabajo)">
        <div class="grp-list">
          ${friends.map((f) => `
            <label class="grp-pick">
              <input type="checkbox" value="${esc(f.uid)}">
              <span class="avatar">${Avatars.html(f.uid, f.name)}</span>
              <span class="g-info"><strong>${esc(f.name)}</strong><span>@${esc(f.uid)}</span></span>
              <span class="pres-dot ${Presence.isOnline(f.uid) ? 'on' : ''}"></span>
            </label>`).join('')}
        </div>
        <div class="m-acts">
          <button class="btn-ghost" data-r="0">Cancelar</button>
          <button class="btn-primary" data-r="1">Crear grupo</button>
        </div>
      </div>`;
    root.hidden = false;
    root.onclick = async (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === '0') { this.closeModal(); return; }
      const name = $('#grpName').value;
      const uids = $$('.grp-pick input:checked').map((i) => i.value);
      try {
        const g = this.create(name, uids);
        this.closeModal();
        App.openChat('g:' + g.id);
      } catch (ex) {
        UI.toast(ex.message || 'No se pudo crear el grupo.');
      }
    };
    setTimeout(() => { const i = $('#grpName'); if (i) i.focus(); }, 60);
  },

  /* ---------- modal: miembros del grupo (con FOTO del grupo) ---------- */
  openMembersModal(gid) {
    const g = this.get(gid);
    if (!g) return;
    const root = $('#modalRoot');
    const members = g.members.map((u) => ({
      uid: u,
      name: u === Auth.me.uid ? Auth.me.name : Friends.name(u),
      me: u === Auth.me.uid
    }));
    const hasPhoto = !!GroupAvatars.get(gid);
    root.innerHTML = `
      <div class="modal group-modal">
        <div class="gp-row">
          <div class="avatar" style="--h:${hueOf(g.id)}">${GroupAvatars.html(gid)}</div>
          <div class="gp-acts">
            <button id="btnGPhoto" class="f-btn chat"><svg class="icon"><use href="#i-camera"/></svg>Cambiar foto</button>
            ${hasPhoto ? '<button id="btnGPhotoDel" class="f-btn reject">Quitar foto</button>' : ''}
          </div>
        </div>
        <h3>${esc(g.name)}</h3>
        <p>${members.length} miembro${members.length !== 1 ? 's' : ''} · creado por @${esc(g.creator)} · toca uno para ver su perfil</p>
        <div class="grp-list">
          ${members.map((m) => `
            <button class="grp-member" data-muid="${esc(m.uid)}" title="Ver perfil">
              <span class="avatar">${Avatars.html(m.uid, m.name)}</span>
              <span class="g-info"><strong>${esc(m.name)}${m.me ? ' (tú)' : ''}</strong><span>@${esc(m.uid)}</span></span>
              ${m.me ? '' : `<span class="pres-dot ${Presence.isOnline(m.uid) ? 'on' : ''}"></span>`}
            </button>`).join('')}
        </div>
        <div class="m-acts">
          <button class="btn-ghost" data-r="0">Cerrar</button>
          <button class="btn-danger" data-r="leave">Salir del grupo</button>
        </div>
      </div>`;
    root.hidden = false;
    root.onclick = (e) => {
      const photo = e.target.closest('#btnGPhoto');
      if (photo) {
        const inp = $('#gPhotoInput');
        if (inp) { inp.dataset.gid = gid; inp.click(); }
        return;
      }
      if (e.target.closest('#btnGPhotoDel')) {
        this.closeModal();
        this.removePhoto(gid);
        return;
      }
      const mem = e.target.closest('.grp-member');
      if (mem && mem.dataset.muid) {
        ProfileCard.open(mem.dataset.muid);
        return;
      }
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === 'leave') {
        this.closeModal();
        UI.confirm('Salir del grupo', `¿Seguro que quieres salir de «${g.name}»? Podrás ser añadido de nuevo por otro miembro.`, 'Salir', true)
          .then((ok) => { if (ok) this.leave(gid); });
      } else this.closeModal();
    };
  },

  closeModal() {
    const root = $('#modalRoot');
    root.hidden = true;
    root.innerHTML = '';
    root.onclick = null;
  }
};
