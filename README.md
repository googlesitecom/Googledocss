# Nexo · Chat en tiempo real — 100% serverless

Mensajería web completa (estilo Hangouts, con diseño propio) que **funciona de verdad** alojada en GitHub Pages: sin backend, sin base de datos propia y sin claves de API. Toda la lógica se ejecuta en el navegador.

**URL (GitHub Pages):** https://googlesitecom.github.io/Googledocss/

## Funciones

- **Cuentas reales** — registro e inicio de sesión con hash PBKDF2-SHA256 (WebCrypto). El directorio de cuentas vive en la red MQTT como mensajes retenidos.
- **Amigos con consentimiento** — buscas a alguien por su usuario exacto, le envías una solicitud y **el otro debe aceptarla** para que se establezca la amistad. Las solicitudes funcionan aunque el destinatario esté desconectado.
- **Chat en tiempo real** — mensajes instantáneos vía broker MQTT público (WSS) con acuses de recibo (✓/✓✓) e indicador de "escribiendo…".
- **Grupos** — crea un grupo con tus amigos: reciben una invitación al instante (o retenida si están desconectados) y todos comparten mensajes, imágenes y notas de voz. Puedes ver los miembros y salir del grupo cuando quieras.
- **Mensajes de voz** — grábalos desde el micrófono (MediaRecorder/Opus) y envíalos como burbujas con reproductor propio: onda generada del audio real, progreso, duración y velocidad 1x/1.5x/2x. Máximo 2 minutos.
- **Fotos de perfil** — sube tu foto (se comprime y publica en tu perfil retenido): tus amigos la ven al instante en listas, chats y llamadas.
- **Bandeja offline (7 días)** — cada mensaje se publica retenido con expiración: si tu contacto está desconectado, lo recibe al volver a conectarse.
- **Imágenes reales** — se comprimen en el navegador (canvas) y se transfieren por fragmentos; se guardan en IndexedDB. Clic para ampliar.
- **Presencia real** — indicador en línea/última conexión con heartbeat + LWT (Last Will and Testament) del broker.
- **Llamadas de voz y video P2P** — WebRTC a través de PeerJS: llamada entrante con avatar pulsante, responder/rechazar, silenciar micrófono, apagar cámara, PiP local y cronómetro.
- **Notificaciones con la app cerrada (Web Push real)** — cada usuario publica su suscripción push en el broker; cuando alguien te escribe y estás desconectado, el navegador del remitente cifra la notificación (RFC 8291, aes128gcm), la firma con VAPID (RFC 8292) y la envía directamente a tu push service: te llega una notificación del sistema **aunque Nexo esté cerrado**, y al tocarla se abre el chat. En iPhone/iPad: instala Nexo en la pantalla de inicio (es una PWA con manifest e iconos) para recibirlas.
- **Sistema de notificaciones** — centro integrado (campana), notificaciones del navegador vía Service Worker (compatible con Android), sonidos sintetizados (WebAudio) y badges de no leídos.
- **Filtro anti-spam** — los mensajes detectados como spam (ráfagas, repeticiones, mayúsculas, enlaces, palabras sospechosas…) se entregan marcados en el chat, pero **no generan ninguna notificación**: ni sonido, ni aviso, ni badge, ni push. Sensibilidad configurable (baja/media/alta) y contador de spam bloqueado.
- **Personalización de tema y fondo** — elige el color de acento (presets o matiz libre; todo el sistema de diseño se recalcula) y el fondo del chat: 6 fondos predefinidos o una imagen propia desde tu dispositivo.

## Arquitectura

| Capa | Tecnología | Uso |
|---|---|---|
| Tiempo real | MQTT sobre WSS (broker público HiveMQ, respaldo EMQX) | cuentas, perfiles (con foto), presencia, solicitudes, mensajes, grupos |
| Notificaciones offline | Web Push (Service Worker + VAPID + aes128gcm, todo firmado/cifrado en el cliente) | avisos con la app cerrada |
| Multimedia | WebRTC vía PeerJS (señalización pública) + MediaRecorder | llamadas y mensajes de voz |
| Cifrado de contraseñas | WebCrypto PBKDF2-SHA256 (60 000 iteraciones) | cuentas |
| Persistencia | localStorage + IndexedDB | sesión, amigos, grupos, historial (400 mensajes/conversación), imágenes, audios, fondo propio |

Espacios de temas (todos bajo `nexo/v1/`): `auth/<u>`, `profile/<u>` (nombre+foto), `presence/<u>`, `psub/<u>` (suscripción push), `freq/<para>/<de>`, `fresp/<para>/<de>`, `dm/<para>/<de>/<idMensaje>[/fragmento]`, `evt/<u>`, `group/<gid>` (descriptor), `ginv/<u>/<gid>` (invitación retenida), `gm/<gid>/<autor>/<id>[/fragmento]` (mensajes de grupo).

## Cómo activar las notificaciones

1. Abre Nexo y pulsa **Activar** en el banner (o Ajustes → Notificaciones → *Notificaciones sin abrir la app*).
2. Permite las notificaciones del navegador.
3. Listo: recibirás avisos de mensajes, grupos, solicitudes y llamadas perdidas aunque cierres la app. El spam detectado nunca genera notificación.

Nota para iPhone/iPad: el sistema exige que la web esté **instalada en la pantalla de inicio** (Compartir → Añadir a inicio) para recibir notificaciones en segundo plano.

## Honestidad técnica (limitaciones)

- Los brokers públicos no autentican escrituras: **no es apto para datos sensibles**. Los payloads de push sí van cifrados de extremo a extremo (aes128gcm), pero el MQTT no.
- El historial, las imágenes y los audios viven por dispositivo (no se sincronizan entre navegadores). Las cuentas, amigos y grupos sí viajan contigo.
- Las llamadas y la grabación de voz requieren que ambos usuarios estén en línea; sin servidor TURN, algunas redes corporativas muy restrictivas pueden bloquear WebRTC.
- Los mensajes offline se retienen 7 días como máximo; las suscripciones push se refrescan al abrir la app (caducan a 30 días).
- El par VAPID de la app vive en el cliente (no hay servidor): es la identidad de la app ante los push services, no un secreto de usuario.

## Desarrollo local

```bash
cd Googledocss
python3 -m http.server 8080
# abre http://localhost:8080
```

Abre la app en dos ventanas/pestañas distintas, registra dos cuentas y pruébala: solicitud de amistad, aceptación, chat, grupos, imágenes, voz, llamadas, notificaciones (con y sin la pestaña abierta) y spam.

## Despliegue

Contenido estático: rama `main`, carpeta raíz, GitHub Pages activado. Sin pasos de compilación.
