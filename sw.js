/* sw.js — Service Worker de Nexo
   Recibe push del sistema operativo aunque la página esté CERRADA
   y muestra la notificación. Al tocarla, abre/enfoca la app y navega
   al chat correspondiente. También permite notificaciones en Android
   (donde Notification API desde página no funciona).            */
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
  const opts = {
    body: data.body || '',
    icon: APP_ICON,
    badge: APP_ICON,
    tag: data.tag || 'nexo',
    renotify: true,
    data: { route: data.route || {} },
    silent: false
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

/* ---------- clic en la notificación ---------- */
self.addEventListener('notificationclick', (event) => {
  const route = (event.notification.data && event.notification.data.route) || {};
  event.notification.close();
  event.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) {
      if ('focus' in c) {
        c.focus();
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
