# Nexo · Chat en tiempo real — 100% serverless

Mensajería web completa (estilo Hangouts, con diseño propio) que **funciona de verdad** alojada en GitHub Pages: sin backend, sin base de datos propia y sin claves de API. Toda la lógica se ejecuta en el navegador.

**URL (GitHub Pages):** https://googlesitecom.github.io/Googledocss/

## Funciones

- **Cuentas reales** — registro e inicio de sesión con hash PBKDF2-SHA256 (WebCrypto). El directorio de cuentas vive en la red MQTT como mensajes retenidos.
- **Amigos con consentimiento** — buscas a alguien por su usuario exacto, le envías una solicitud y **el otro debe aceptarla** para que se establezca la amistad. Las solicitudes funcionan aunque el destinatario esté desconectado.
- **Chat en tiempo real** — mensajes instantáneos vía broker MQTT público (WSS) con acuses de recibo (✓/✓✓) e indicador de "escribiendo…".
- **Bandeja offline (7 días)** — cada mensaje se publica retenido con expiración: si tu amigo está desconectado, lo recibe al volver a conectarse.
- **Imágenes reales** — se comprimen en el navegador (canvas) y se transfieren por fragmentos; se guardan en IndexedDB. Clic para ampliar.
- **Presencia real** — indicador en línea/desconectado con heartbeat + LWT (Last Will and Testament) del broker.
- **Llamadas de voz y video P2P** — WebRTC a través de PeerJS: llamada entrante con avatar pulsante, responder/rechazar, silenciar micrófono, apagar cámara, PiP local y cronómetro.
- **Sistema de notificaciones** — centro integrado (campana), notificaciones del navegador (Notification API) cuando la pestaña está en segundo plano, sonidos sintetizados (WebAudio) y badges de no leídos.
- **Filtro anti-spam** — los mensajes detectados como spam (ráfagas, repeticiones, mayúsculas, enlaces, palabras sospechosas…) se entregan marcados en el chat, pero **no generan ninguna notificación**. Sensibilidad configurable (baja/media/alta) y contador de spam bloqueado.

## Arquitectura

| Capa | Tecnología | Uso |
|---|---|---|
| Tiempo real | MQTT sobre WSS (broker público HiveMQ, respaldo EMQX) | cuentas, perfiles, presencia, solicitudes de amistad, mensajería, acuses |
| Multimedia | WebRTC vía PeerJS (servidor de señalización público) | llamadas de voz y video |
| Cifrado de contraseñas | WebCrypto PBKDF2-SHA256 (60 000 iteraciones) | cuentas |
| Persistencia | localStorage + IndexedDB | sesión, amigos, historial (400 mensajes/conversación), imágenes |

Espacios de temas (todos bajo `nexo/v1/`): `auth/<u>`, `profile/<u>`, `presence/<u>`, `freq/<para>/<de>`, `fresp/<para>/<de>`, `dm/<para>/<de>/<idMensaje>[/fragmento]`, `evt/<u>`.

## Honestidad técnica (limitaciones)

- Los brokers públicos no autentican escrituras: **no es apto para datos sensibles** ni tiene cifrado de extremo a extremo. Es la contrapartida de funcionar sin servidor ni claves.
- El historial y las imágenes viven por dispositivo (no se sincronizan entre navegadores).
- Las llamadas requieren que ambos usuarios estén en línea; sin servidor TURN, algunas redes corporativas muy restrictivas pueden bloquear WebRTC.
- Los mensajes offline se retienen 7 días como máximo.

## Desarrollo local

```bash
cd Googledocss
python3 -m http.server 8080
# abre http://localhost:8080
```

Abre la app en dos ventanas/pestañas distintas, registra dos cuentas y pruébala: solicitud de amistad, aceptación, chat, imágenes, llamadas, notificaciones y spam.

## Despliegue

Contenido estático: rama `main`, carpeta raíz, GitHub Pages activado. Sin pasos de compilación.
