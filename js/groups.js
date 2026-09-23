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
      admins: [],              /* v11: solo el creador nombra administradores */
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
      admins: g.admins || [],
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
    /* v11: administradores nombrados por el creador (descriptor nuevo) */
    if (Array.isArray(m.admins)) {
      const clean = m.admins.filter((x) => Array.isArray(m.members || mine.members) && (m.members || mine.members).includes(x));
      const a = [...clean].sort().join(',');
      const b = [...(mine.admins || [])].sort().join(',');
      if (a !== b) { mine.admins = clean; changed = true; }
    }
    if (changed) {
      this.save(list);
      /* vigilar presencia/perfil de los miembros nuevos (p. ej. añadidos
         por el creador aunque no sean amigos míos) */
      (mine.members || []).forEach((u) => Presence.watch(u));
      App.renderConvoList();
      if (Chat.active === 'g:' + gid) Chat.renderHeaderInfo('g:' + gid);
      /* v11: si el panel de miembros está abierto, refrescarlo en vivo
         (cambios de rol vistos al instante, estilo WhatsApp) */
      if (this._modalGid === gid && !$('#modalRoot').hidden) this.openMembersModal(gid);
    }
  },

  /* ================== ADMINISTRACIÓN: CREADOR + ADMINISTRADORES (v11) ==================
     El CREADOR puede: añadir miembros, renombrar, expulsar a cualquiera
     y NOMBRAR/QUITAR ADMINISTRADORES.
     Los ADMINISTRADORES pueden: añadir miembros, renombrar, cambiar la
     foto y expulsar a miembros normales (nunca al creador ni a otros
     administradores).
     Todo se propaga con el descriptor retenido + un mensaje de sistema
     que queda en el historial de todos (estilo WhatsApp).                   */

  isCreator(gid) {
    const g = this.get(gid);
    return !!g && g.creator === Auth.me.uid;
  },
  isAdminOf(gid, uid) {
    const g = this.get(gid);
    return !!g && (g.admins || []).includes(uid);
  },
  /* ¿puedo gestionar este grupo? (creador o administrador) */
  canManage(gid) {
    const g = this.get(gid);
    return !!g && (g.creator === Auth.me.uid || (g.admins || []).includes(Auth.me.uid));
  },

  /* ---------- mensaje de sistema del grupo (autor «sys») ----------
     Se publica como mensaje RETENIDO (7 días) sobre
     nexo/v1/gm/<gid>/sys/<id> → entra en el historial de todos los
     miembros, también de quien conecte más tarde.                        */
  sysMsg(gid, { k, text, extra }) {
    const g = this.get(gid);
    if (!g || !text) return null;
    const id = rid();
    const ts = Date.now();
    const payload = { t: 'gsysmsg', id, k, from: Auth.me.uid, name: Auth.me.name, text, ts };
    if (extra !== undefined) payload.extra = extra;
    Mqtt.publish(T.gm(gid, 'sys', id), payload, { retain: true, expiry: 604800 });
    /* copia local inmediata (el eco retenido se deduplica por id) */
    const m = { t: 'sys', id, k, text, from: Auth.me.uid, name: Auth.me.name, ts };
    if (extra !== undefined) m.extra = extra;
    Chat.addHist('g:' + gid, m);
    if (Chat.active === 'g:' + gid) Chat.appendBubble('g:' + gid, m);
    App.renderConvoList();
    return id;
  },

  /* ---------- AÑADIR miembros después de crear el grupo ---------- */
  addMembers(gid, memberUids) {
    const g = this.get(gid);
    if (!g) throw new Error('Grupo no encontrado.');
    if (!this.canManage(gid)) throw new Error('Solo el creador o un administrador pueden añadir miembros.');
    const uniq = [...new Set((memberUids || []))]
      .filter((u) => u && u !== Auth.me.uid && Friends.isFriend(u) && !g.members.includes(u));
    if (!uniq.length) throw new Error('Elige al menos un amigo que aún no esté en el grupo.');

    g.members = [...g.members, ...uniq];
    const list = this.all();
    const idx = list.findIndex((x) => x.id === gid);
    if (idx >= 0) list[idx] = g;
    this.save(list);
    uniq.forEach((u) => Presence.watch(u));

    /* descriptor retenido: todos ven la lista nueva al instante */
    this.publishDescriptor(g);

    /* mensaje de sistema en el historial del grupo */
    const pretty = (a) => a.length <= 1 ? String(a[0] || '') : a.slice(0, -1).join(', ') + ' y ' + a[a.length - 1];
    this.sysMsg(gid, {
      k: 'added',
      text: `${Auth.me.name} añadió a ${pretty(uniq.map((u) => Friends.name(u)))} al grupo.`,
      extra: uniq.map((u) => ({ uid: u, name: Friends.name(u) }))
    });

    /* invitación retenida a cada nuevo miembro + push si está desconectado
       (mismo mecanismo que al crear: entra aunque no esté conectado)      */
    uniq.forEach((u) => {
      Mqtt.publish(T.ginv(u, g.id), {
        gid: g.id, name: g.name, from: Auth.me.uid, fromName: Auth.me.name, ts: Date.now()
      }, { retain: true, expiry: 2592000 });
      Mqtt.publish(T.evt(u), { t: 'ginvite', gid: g.id, name: g.name, from: Auth.me.uid, fromName: Auth.me.name });
      if (!Presence.isOnline(u)) {
        Push.notify(u, 'Te añadieron a un grupo', `${Auth.me.name} te añadió al grupo «${g.name}»`, { chat: 'g:' + gid });
      }
    });

    App.renderConvoList();
    if (Chat.active === 'g:' + gid) Chat.renderHeaderInfo('g:' + gid);
    UI.toast(uniq.length === 1
      ? `${Friends.name(uniq[0])} fue añadido al grupo.`
      : `${uniq.length} miembros fueron añadidos al grupo.`);
    return uniq;
  },

  /* ---------- CAMBIAR el nombre del grupo ---------- */
  rename(gid, newName) {
    newName = String(newName || '').trim();
    if (newName.length < 2 || newName.length > 40) throw new Error('El nombre del grupo debe tener entre 2 y 40 caracteres.');
    const g = this.get(gid);
    if (!g) throw new Error('Grupo no encontrado.');
    if (!this.canManage(gid)) throw new Error('Solo el creador o un administrador pueden cambiar el nombre.');
    if (newName === g.name) return false;
    const old = g.name;
    g.name = newName;
    const list = this.all();
    const idx = list.findIndex((x) => x.id === gid);
    if (idx >= 0) list[idx] = g;
    this.save(list);
    this.publishDescriptor(g);
    this.sysMsg(gid, {
      k: 'renamed',
      text: `${Auth.me.name} cambió el nombre del grupo de «${old}» a «${newName}».`,
      extra: { from: old, to: newName }
    });
    App.renderConvoList();
    if (Chat.active === 'g:' + gid) Chat.renderHeaderInfo('g:' + gid);
    UI.toast(`Nuevo nombre del grupo: «${newName}».`);
    return true;
  },

  /* ---------- EXPULSAR a un miembro (creador o administrador) ----------
     El descriptor actualizado hace que su cliente se salga solo; se retira
     su invitación retenida para que no reentre al reconectar.
     Reglas: nadie expulsa al creador; un administrador no puede expulsar
     a otro administrador (solo el creador puede).                       */
  removeMember(gid, uid) {
    const g = this.get(gid);
    if (!g) return;
    const isCreator = g.creator === Auth.me.uid;
    const iAmAdmin = (g.admins || []).includes(Auth.me.uid);
    if (!isCreator && !iAmAdmin) { UI.toast('Solo el creador o un administrador puede eliminar miembros.'); return; }
    if (!uid || uid === Auth.me.uid || uid === g.creator || !g.members.includes(uid)) return;
    if (iAmAdmin && !isCreator && (g.admins || []).includes(uid)) {
      UI.toast('Un administrador no puede eliminar a otro administrador.');
      return;
    }
    const name = Friends.name(uid);
    g.members = g.members.filter((u) => u !== uid);
    g.admins = (g.admins || []).filter((u) => u !== uid);
    const list = this.all();
    const idx = list.findIndex((x) => x.id === gid);
    if (idx >= 0) list[idx] = g;
    this.save(list);
    this.publishDescriptor(g);
    /* retirar la invitación retenida: si está desconectado, al volver
       a conectar no debe reentrar al grupo */
    Mqtt.publish(T.ginv(uid, gid), '', { retain: true });
    this.sysMsg(gid, {
      k: 'removed',
      text: `${Auth.me.name} eliminó a ${name} del grupo.`,
      extra: { uid, name }
    });
    App.renderConvoList();
    if (Chat.active === 'g:' + gid) Chat.renderHeaderInfo('g:' + gid);
    UI.toast(`${name} ya no está en el grupo.`);
  },

  /* ---------- NOMBRAR ADMINISTRADOR (solo el creador) ---------- */
  promote(gid, uid) {
    const g = this.get(gid);
    if (!g) return;
    if (g.creator !== Auth.me.uid) { UI.toast('Solo el creador del grupo puede nombrar administradores.'); return; }
    if (!uid || uid === Auth.me.uid || uid === g.creator || !g.members.includes(uid)) return;
    if ((g.admins || []).includes(uid)) return;
    g.admins = [...(g.admins || []), uid];
    const list = this.all();
    const idx = list.findIndex((x) => x.id === gid);
    if (idx >= 0) list[idx] = g;
    this.save(list);
    this.publishDescriptor(g);
    const name = Friends.name(uid);
    this.sysMsg(gid, {
      k: 'admin',
      text: `${Auth.me.name} hizo administrador a ${name}.`,
      extra: { uid, name }
    });
    /* aviso directo al nuevo administrador (en vivo o con push) */
    Mqtt.publish(T.evt(uid), { t: 'gadmin', gid, gname: g.name, from: Auth.me.uid, fromName: Auth.me.name });
    if (!Presence.isOnline(uid)) {
      Push.notify(uid, 'Nuevo administrador', `${Auth.me.name} te hizo administrador del grupo «${g.name}»`, { chat: 'g:' + gid });
    }
    App.renderConvoList();
    UI.toast(`${name} ahora es administrador del grupo.`);
  },

  /* ---------- QUITAR ADMINISTRADOR (solo el creador) ---------- */
  demote(gid, uid) {
    const g = this.get(gid);
    if (!g) return;
    if (g.creator !== Auth.me.uid) { UI.toast('Solo el creador del grupo puede quitar administradores.'); return; }
    if (!uid || !(g.admins || []).includes(uid)) return;
    g.admins = (g.admins || []).filter((u) => u !== uid);
    const list = this.all();
    const idx = list.findIndex((x) => x.id === gid);
    if (idx >= 0) list[idx] = g;
    this.save(list);
    this.publishDescriptor(g);
    const name = Friends.name(uid);
    this.sysMsg(gid, {
      k: 'deadmin',
      text: `${Auth.me.name} quitó a ${name} como administrador.`,
      extra: { uid, name }
    });
    Mqtt.publish(T.evt(uid), { t: 'gdeadmin', gid, gname: g.name, from: Auth.me.uid, fromName: Auth.me.name });
    App.renderConvoList();
    UI.toast(`${name} ya no es administrador del grupo.`);
  },

  /* ---------- FOTO DEL GRUPO (creador o administrador) ---------- */
  async setPhoto(gid, file) {
    const g = this.get(gid);
    if (!g) throw new Error('Grupo no encontrado.');
    if (!this.canManage(gid)) throw new Error('Solo el creador o un administrador pueden cambiar la foto.');
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
    if (!this.canManage(gid)) { UI.toast('Solo el creador o un administrador pueden quitar la foto.'); return; }
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
      admins: [],
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

  /* ---------- modal: miembros del grupo (roles, badges y ADMIN) ---------- */
  openMembersModal(gid) {
    const g = this.get(gid);
    if (!g) return;
    this._modalGid = gid;
    const root = $('#modalRoot');
    const isCreator = g.creator === Auth.me.uid;
    const iAmAdmin = (g.admins || []).includes(Auth.me.uid);
    const canManage = isCreator || iAmAdmin;
    const admins = g.admins || [];
    const members = g.members.map((u) => ({
      uid: u,
      name: u === Auth.me.uid ? Auth.me.name : Friends.name(u),
      me: u === Auth.me.uid,
      admin: admins.includes(u) && u !== g.creator
    }));
    const hasPhoto = !!GroupAvatars.get(gid);
    const roleTxt = isCreator
      ? ' · eres el creador: puedes añadir, renombrar, expulsar y nombrar administradores'
      : iAmAdmin
        ? ' · eres administrador: puedes añadir, renombrar y expulsar miembros'
        : ' · toca uno para ver su perfil';
    root.innerHTML = `
      <div class="modal group-modal">
        <div class="gp-row">
          <div class="avatar" style="--h:${hueOf(g.id)}">${GroupAvatars.html(gid)}</div>
          <div class="gp-acts">
            ${canManage ? `
            <button id="btnGPhoto" class="f-btn chat"><svg class="icon"><use href="#i-camera"/></svg>Cambiar foto</button>
            ${hasPhoto ? '<button id="btnGPhotoDel" class="f-btn reject">Quitar foto</button>' : ''}` : ''}
          </div>
        </div>
        <div class="gp-title">
          <h3>${esc(g.name)}</h3>
          ${canManage ? `<button id="btnGRename" class="gp-edit" title="Cambiar el nombre del grupo" aria-label="Cambiar el nombre del grupo"><svg class="icon"><use href="#i-edit"/></svg></button>` : ''}
        </div>
        <p>${members.length} miembro${members.length !== 1 ? 's' : ''} · creado por @${esc(g.creator)}${roleTxt}</p>
        <div class="grp-list">
          ${members.map((m) => {
            const badge = m.uid === g.creator
              ? '<span class="g-badge creator">creador</span>'
              : (m.admin ? '<span class="g-badge admin">admin</span>' : '');
            /* expulsar: creador → cualquiera (salvo él); admin → solo miembros normales */
            const canKick = canManage && !m.me && m.uid !== g.creator && (isCreator || !m.admin);
            /* escudo (nombrar/quitar administrador): solo el creador */
            const shield = (isCreator && !m.me && m.uid !== g.creator)
              ? `<button class="gm-shield ${m.admin ? 'on' : ''}" data-suid="${esc(m.uid)}" data-sadm="${m.admin ? 1 : 0}" title="${m.admin ? 'Quitar como administrador' : 'Hacer administrador'}" aria-label="${m.admin ? 'Quitar a ' + esc(m.name) + ' como administrador' : 'Hacer a ' + esc(m.name) + ' administrador'}"><svg class="icon"><use href="#i-shield"/></svg></button>`
              : '';
            const kick = canKick
              ? `<button class="gm-x" data-xuid="${esc(m.uid)}" title="Eliminar del grupo" aria-label="Eliminar a ${esc(m.name)} del grupo"><svg class="icon"><use href="#i-x"/></svg></button>`
              : '';
            return `
            <div class="grp-member">
              <button class="grp-mid" data-muid="${esc(m.uid)}" title="Ver perfil">
                <span class="avatar">${Avatars.html(m.uid, m.name)}</span>
                <span class="g-info"><strong>${esc(m.name)}${m.me ? ' (tú)' : ''}${badge}</strong><span>@${esc(m.uid)}</span></span>
                ${m.me ? '' : `<span class="pres-dot ${Presence.isOnline(m.uid) ? 'on' : ''}"></span>`}
              </button>
              ${shield}${kick}
            </div>`;
          }).join('')}
        </div>
        ${canManage ? `<button id="btnGAdd" class="f-btn add gp-add"><svg class="icon"><use href="#i-user-plus"/></svg>Añadir miembros</button>` : ''}
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
      if (e.target.closest('#btnGRename')) { this.openRenameModal(gid); return; }
      if (e.target.closest('#btnGAdd')) { this.openAddModal(gid); return; }
      const sh = e.target.closest('.gm-shield');
      if (sh && sh.dataset.suid) {
        const who = Friends.name(sh.dataset.suid);
        if (sh.dataset.sadm === '1') {
          UI.confirm('Quitar administrador', `¿Quitar a ${who} como administrador del grupo «${g.name}»? Seguirá siendo miembro.`, 'Quitar admin', true)
            .then((ok) => { if (ok) { this.demote(gid, sh.dataset.suid); this.openMembersModal(gid); } });
        } else {
          this.promote(gid, sh.dataset.suid);
          this.openMembersModal(gid);
        }
        return;
      }
      const kick = e.target.closest('.gm-x');
      if (kick && kick.dataset.xuid) {
        const who = Friends.name(kick.dataset.xuid);
        UI.confirm('Eliminar del grupo', `¿Quitar a ${who} del grupo «${g.name}»? Podrás volver a añadirlo más tarde.`, 'Eliminar', true)
          .then((ok) => { if (ok) { this.removeMember(gid, kick.dataset.xuid); this.openMembersModal(gid); } });
        return;
      }
      const mem = e.target.closest('.grp-mid');
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

  /* ---------- modal: AÑADIR MIEMBROS (creador o administrador) ---------- */
  openAddModal(gid) {
    const g = this.get(gid);
    if (!g || !this.canManage(gid)) return;
    const candidates = Friends.all().filter((f) => !g.members.includes(f.uid));
    const root = $('#modalRoot');
    if (!candidates.length) {
      root.innerHTML = `
        <div class="modal group-modal">
          <h3>Añadir miembros</h3>
          <p>Todos tus amigos ya están en «${esc(g.name)}». Cuando añadas nuevos amigos podrás incluirlos aquí en cualquier momento.</p>
          <div class="m-acts">
            <button class="btn-ghost" data-r="0">Volver</button>
          </div>
        </div>`;
      root.hidden = false;
      root.onclick = (e) => { if (e.target.closest('[data-r]')) this.openMembersModal(gid); };
      return;
    }
    root.innerHTML = `
      <div class="modal group-modal">
        <h3>Añadir miembros</h3>
        <p>Los amigos que elijas entrarán en «${esc(g.name)}» al instante, aunque no estén conectados ahora mismo.</p>
        <div class="grp-list">
          ${candidates.map((f) => `
            <label class="grp-pick">
              <input type="checkbox" value="${esc(f.uid)}">
              <span class="avatar">${Avatars.html(f.uid, f.name)}</span>
              <span class="g-info"><strong>${esc(f.name)}</strong><span>@${esc(f.uid)}</span></span>
              <span class="pres-dot ${Presence.isOnline(f.uid) ? 'on' : ''}"></span>
            </label>`).join('')}
        </div>
        <div class="m-acts">
          <button class="btn-ghost" data-r="0">Cancelar</button>
          <button class="btn-primary" data-r="1">Añadir al grupo</button>
        </div>
      </div>`;
    root.hidden = false;
    root.onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === '0') { this.openMembersModal(gid); return; }
      const uids = $$('.grp-pick input:checked').map((i) => i.value);
      try {
        this.addMembers(gid, uids);
        this.openMembersModal(gid); /* volver al panel ya actualizado */
      } catch (ex) {
        UI.toast(ex.message || 'No se pudieron añadir los miembros.');
      }
    };
  },

  /* ---------- modal: CAMBIAR EL NOMBRE (creador o administrador) ---------- */
  openRenameModal(gid) {
    const g = this.get(gid);
    if (!g || !this.canManage(gid)) return;
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal group-modal">
        <h3>Cambiar el nombre</h3>
        <p>El creador y los administradores pueden renombrar el grupo. Todos los miembros verán el cambio al instante y quedará en el historial.</p>
        <input id="grpRename" class="set-input" maxlength="40" value="${esc(g.name)}" spellcheck="false">
        <div class="m-acts">
          <button class="btn-ghost" data-r="0">Cancelar</button>
          <button class="btn-primary" data-r="1">Guardar nombre</button>
        </div>
      </div>`;
    root.hidden = false;
    const inp = $('#grpRename');
    const save = () => {
      try {
        const changed = this.rename(gid, inp.value);
        this.openMembersModal(gid);
        if (changed === false) UI.toast('El nombre ya era ese: no hubo cambios.');
      } catch (ex) {
        UI.toast(ex.message || 'No se pudo cambiar el nombre.');
      }
    };
    root.onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === '1') save();
      else this.openMembersModal(gid);
    };
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
    inp.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  },

  closeModal() {
    const root = $('#modalRoot');
    this._modalGid = null;
    root.hidden = true;
    root.innerHTML = '';
    root.onclick = null;
  }
};
