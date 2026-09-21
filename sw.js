/* sw.js — Service Worker de Nexo
   Recibe push del sistema operativo aunque la página esté CERRADA
   y muestra la notificación. Al tocarla, abre/enfoca la app y navega
   al chat correspondiente. También permite notificaciones en Android
   (donde Notification API desde página no funciona).

   DEDUPLICACIÓN POR VISIBILIDAD:
   - Si hay una ventana de Nexo VISIBLE (el usuario la está viendo),
     la propia página ya notifica dentro (toast/centro); el push se
     marca como silencioso con el mismo tag por chat (se agrupa y no
     suena), y se avisa a la página por postMessage.
   - Si todas las ventanas están OCULTAS o CERRADAS → notificación
     completa con sonido y renotify: es el caso "no estoy con la
     pestaña/app abierta".                                                        */
'use strict';

const APP_ICON = './icons/icon-192.png';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

/* ---------- notificación push entrante ---------- */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: 'Nexo', body: 'Tienes mensajes nuevos' };
  }
  const title = data.title || 'Nexo';
  const route = data.route || {};
  const tag = data.tag || (route.chat ? 'nexo-msg-' + route.chat : 'nexo');

  event.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = cs.some((c) => c.visibilityState === 'visible');

    if (visible && !route.test) {
      /* la app está abierta y a la vista: ella ya avisa dentro */
      cs.forEach((c) => { try { c.postMessage({ nexoPushedNotif: data }); } catch (e) {} });
      /* notificación discreta (requisito userVisibleOnly de Chrome):
         silenciosa, sin renotify y con el mismo tag → se agrupa con
         la que pueda haber generado la propia página              */
      return self.registration.showNotification(title, {
        body: data.body || '',
        icon: APP_ICON,
        badge: APP_ICON,
        tag,
        renotify: false,
        silent: true,
        data: { route }
      });
    }

    /* pestaña oculta o app cerrada → notificación completa */
    return self.registration.showNotification(title, {
      body: data.body || '',
      icon: APP_ICON,
      badge: APP_ICON,
      tag,
      renotify: true,
      silent: false,
      data: { route }
    });
  })());
});

/* ---------- clic en la notificación ---------- */
self.addEventListener('notificationclick', (event) => {
  const route = (event.notification.data && event.notification.data.route) || {};
  event.notification.close();
  event.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) {
      if ('focus' in c) {
        try { await c.focus(); } catch (e) {}
        c.postMessage({ nexoRoute: route });
        return;
      }
    }
    const url = new URL('./', self.registration.scope).href;
    await self.clients.openWindow(url + (route.chat ? '#c=' + encodeURIComponent(route.chat) : ''));
  })());
});

/* ---------- la suscripción caducó/rotó: re-suscribir ----------
   (la página vuelve a publicarla en MQTT cuando se abra)          */
self.addEventListener('pushsubscriptionchange', (event) => {
  const RAW = 'BBUQRDKbw1nH4q3CkVMrOg8TcW0xsW0FftAW8I3FNx7pftrfLnusei0EjZ0A1d2ObDiYDPpOvyAFJm8zqDFEdFY';
  event.waitUntil((async () => {
    try {
      const reg = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(atob(RAW.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      });
      /* avisar a las páginas abiertas para que re-publiquen en MQTT */
      const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      cs.forEach((c) => c.postMessage({ nexoPushSubChanged: true }));
      return reg;
    } catch (e) { /* mejor esfuerzo */ }
  })());
});

/* ---------- mensajes de la página ---------- */
self.addEventListener('message', (e) => {
  const d = e.data || {};
  /* la página pide mostrar una notificación vía SW (soporte Android) */
  if (d.nexoShow) {
    const n = d.nexoShow;
    self.registration.showNotification(n.title, {
      body: n.body || '',
      icon: n.icon || APP_ICON,
      badge: APP_ICON,
      tag: n.tag || 'nexo',
      data: { route: n.route || {} }
    });
  }
});
