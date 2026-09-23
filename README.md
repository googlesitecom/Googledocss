# Nexo · Chat en tiempo real — 100% serverless

Mensajería web completa (estilo Hangouts, con diseño propio) que **funciona de verdad** alojada en GitHub Pages: sin backend, sin base de datos propia y sin claves de API. Toda la lógica se ejecuta en el navegador.

**URL (GitHub Pages):** https://googlesitecom.github.io/Googledocss/

## Funciones

- **Cuentas reales** — registro e inicio de sesión con hash PBKDF2-SHA256 (WebCrypto). El directorio de cuentas vive en la red MQTT como mensajes retenidos.
- **Amigos con consentimiento** — buscas a alguien por su usuario exacto, le envías una solicitud y **el otro debe aceptarla** para que se establezca la amistad. Las solicitudes funcionan aunque el destinatario esté desconectado.
- **Chat en tiempo real** — mensajes instantáneos vía broker MQTT público (WSS) con acuses de recibo (✓/✓✓) e indicador de "escribiendo…".
- **Grupos** — crea un grupo con tus amigos: reciben una invitación al instante (o retenida si están desconectados) y todos comparten mensajes, imágenes y notas de voz. Puedes ver los miembros y salir del grupo cuando quieras.
- **Administración del grupo por su creador (v8)** — el creador puede, **en cualquier momento (incluso mucho después de crearlo)**:
  - **Añadir gente al grupo**: botón «Añadir miembros» en el panel del grupo; los elegidos entran al instante (invitación retenida si están desconectados, con push) y todos ven el aviso «X añadió a Y al grupo».
  - **Cambiar el nombre del grupo**: lápiz junto al nombre; se valida (2–40 caracteres), se propaga en vivo a todos los miembros y queda registrado en el historial.
  - **Expulsar a un miembro**: botón ✕ en la fila del miembro; el expulsado sale del grupo automáticamente en su dispositivo (y no reentra al reconectar, porque su invitación retenida se retira).
  Todo se sincroniza con el descriptor retenido del grupo y con **mensajes de sistema** retenidos (7 días) que aparecen como píldoras centradas en el chat — igual que WhatsApp — y también llegan a quien conecte después (p. ej. quien entra nuevo ve quién renombró el grupo antes de que él entrara).
- **Administradores del grupo (v11)** — el **dueño (creador) puede nombrar y quitar administradores** con el botón de escudo 🛡 en la fila de cada miembro (los administradores se ven con el chip «ADMIN» y el creador con el chip dorado «CREADOR»):
  - **Los administradores pueden** añadir miembros, cambiar el nombre y la foto del grupo y **expulsar a miembros normales** — igual que el creador, y también con mensajes de sistema («X hizo administrador a Y», «X quitó a Y como administrador»).
  - **Protecciones de rol** (estilo WhatsApp): nadie expulsa al creador; un administrador no puede expulsar a otro administrador ni tocar los roles — **solo el creador nombra y degrada**. El nuevo administrador recibe un aviso al instante (o push si está desconectado).
  - **Refresco en vivo**: si tienes el panel de miembros abierto, los cambios de rol de otros aparecen al segundo en tu pantalla. El descriptor del grupo ahora incluye la lista `admins` (compatible con clientes anteriores).
- **Cambiar tu nombre de usuario (v9)** — en Ajustes → Perfil, fila «Usuario» → **Cambiar**: pide el nuevo usuario y **tu contraseña actual para confirmar** (la contraseña no cambia). Como el usuario es la identidad de la cuenta en toda la red, el cambio es una migración completa y transparente:
  - La cuenta y el perfil se re-publican bajo el nuevo usuario (mismo hash de contraseña) y se limpian los retenidos antiguos; inicias sesión con el nuevo usuario y la misma contraseña.
  - Tus **amigos, grupos, historiales, stickers y ajustes se conservan**: los datos locales migran de ámbito y los descriptores de tus grupos se re-publican con el nuevo uid (miembro y creador).
  - Tus amigos se enteran **al instante** (evento «rename») o **al reconectar** (puntero retenido `moved` sobre tu presencia antigua, con 30 días de validez): su lista de amigos, historial del chat, no leídos, avatar y chats fijados/silenciados se migran solos a tu nuevo usuario, con un aviso «X cambió su usuario a @nuevo».
  - Un **puente temporal de 2 minutos** recoge los mensajes que algún amigo aún enviara a tu usuario antiguo, para que nada se pierda durante el cambio.
- **Copia de seguridad en la nube — tus chats y ajustes en todos tus dispositivos (v10)** — al cerrar sesión o entrar desde otro móvil/PC **nada se pierde**: todos tus chats, amigos, grupos, stickers, no leídos y ajustes (tema, color de acento, fondo, sonidos…) se guardan **cifrados con tu contraseña** en la propia red del broker y se restauran solos al iniciar sesión en cualquier dispositivo:
  - **Cifrado real de extremo a extremo para la copia**: AES-GCM 256 con clave derivada de tu contraseña (PBKDF2-SHA256, sal propia). Por el broker solo viaja texto cifrado: **ni el broker ni nadie puede leer tus chats sin tu contraseña**. La clave se guarda en el dispositivo solo mientras la sesión está iniciada (se borra al cerrar sesión).
  - **Restauración automática al entrar**: en el login se recupera la copia y se fusiona con lo que ya hubiera (unión de historiales por mensaje, amigos y grupos que falten, ajustes que no tengas). **Las fotos, stickers y notas de voz también viajan** (multimedia incremental: solo se sube lo nuevo; tope de 200 elementos / 6 MB) y se restauran en segundo plano.
  - **Auto-respaldo**: cualquier cambio (mensajes, ajustes, amigos, grupos…) re-publica la copia cifrada unos segundos después; al **cerrar sesión** se guarda una copia completa antes de salir y tus chats se **conservan también en ese dispositivo**.
  - **Ajustes → Copia de seguridad**: estado (última copia, tamaño, multimedia), interruptores de copia automática e inclusión de multimedia, **«Respaldar ahora»**, **«Restaurar en este dispositivo»** y **«Borrar la copia de la nube»** (los dos últimos y el respaldo manual sin sesión piden tu contraseña).
  - **Compatible con el cambio de usuario (v9)**: si cambias tu @usuario, la copia migra contigo (los chunks cifrados se re-publican bajo el nuevo usuario y se limpian los antiguos).
  - Temas MQTT: `bk/<uid>/dm` + `bk/<uid>/d/<i>` (datos), `bk/<uid>/fm` + `bk/<uid>/f/<id>/<i>` (multimedia); manifiestos con sal/iv/numero de chunks; publicación **QoS 1** (acuse del broker, con reintento) para que ningún chunk se pierda.
- **Respaldo DURADERO en GitHub — sobrevive a reinicios de fábrica (v11)** — el broker público **no garantiza** la retención: un reinicio o purga del servicio puede borrar la copia (así se perdieron chats y contactos tras restaurar un dispositivo de fábrica). Nexo puede espejar **la misma copia cifrada** como archivos JSON de la rama **`nx-backups`** del repositorio donde vive la propia app (Googledocss), en Ajustes → Copia de seguridad → **«Conectar GitHub»**:
  - **Lectura pública sin token** (repositorio público + raw.githubusercontent): un dispositivo nuevo restaura con solo **usuario y contraseña**. **Escritura** con tu token de acceso personal (PAT, ámbito «repo»), que se pega una sola vez y **viaja cifrado dentro de la propia copia** → tus otros dispositivos lo recuperan solo al iniciar sesión y siguen respaldando sin que hagas nada.
  - **La cuenta también viaja dentro de la copia** (`acct`: sal + hash PBKDF2): si el broker pierde tu registro (purga total), el **inicio de sesión se recupera desde GitHub** y el directorio del broker se auto-repara al reconectar. Un reinicio de fábrica + purga del broker ya no borra nada.
  - **Fusión aditiva de ambas fuentes**: al entrar se restaura y fusiona el broker (rápido) y el espejo duradero (fiable), con verificación de checksum por manifiesto (protege contra lecturas mixtas del CDN durante la propagación) y reintento automático. El espejo se actualiza tras cada cambio (con límite de 1 vez cada 5 min para no llenar de commits la rama) y siempre al cerrar sesión o con «Respaldar ahora».
  - **Multimedia incluida**: las fotos, stickers y notas de voz se espejan blob a blob (incremental) y se restauran en cualquier dispositivo, buscando cada fragmento en el broker y, si falta, en GitHub.
  - **Cambio de usuario (v9) compatible**: la copia duradera migra al nuevo @usuario (se copian los chunks cifrados tal cual y se limpian los antiguos); «Borrar copia de la nube» elimina también el espejo de GitHub.
  - Archivos: `bk/<uid>/dm.json`, `bk/<uid>/d/<i>.json`, `bk/<uid>/fm.json`, `bk/<uid>/f/<idBlob>/<i>.json` (mismos payloads cifrados que los temas MQTT). La rama dedicada no toca `main` ni dispara reconstrucciones de Pages.
- **Mensajes de voz** — grábalos desde el micrófono (MediaRecorder/Opus) y envíalos como burbujas con reproductor propio: onda generada del audio real, progreso, duración y velocidad 1x/1.5x/2x. Máximo 2 minutos.
- **Fotos de perfil** — sube tu foto (se comprime y publica en tu perfil retenido): tus amigos la ven al instante en listas, chats y llamadas.
- **Ver el perfil de cualquiera** — toca el avatar o el nombre de alguien (cabecera del chat, autor de cualquier mensaje de grupo, lista de amigos, miembros de un grupo o tu propio avatar del lateral) y se abre su ficha: foto grande, nombre, @usuario, estado (en línea / última conexión), **«Acerca de»** (una descripción que cada cual escribe en Ajustes) y acciones según la relación: chatear, llamar, videollamar, añadir o eliminar amigo. Los cambios de foto, nombre o descripción se propagan en vivo.
- **Bandeja offline (7 días)** — cada mensaje se publica retenido con expiración: si tu contacto está desconectado, lo recibe al volver a conectarse.
- **Imágenes reales** — se comprimen en el navegador (canvas) y se transfieren por fragmentos; se guardan en IndexedDB. Clic para ampliar.
- **Presencia real** — indicador en línea/última conexión con heartbeat + LWT (Last Will and Testament) del broker.
- **Llamadas de voz y video P2P** — WebRTC a través de PeerJS: llamada entrante con avatar pulsante, responder/rechazar, silenciar micrófono, apagar cámara, PiP local y cronómetro.
- **Llamadas GRUPALES** — llama a todo un grupo (voz o video): topología en malla WebRTC donde cada participante se conecta directamente con el resto. Invitación en vivo a todos los miembros (con push a los desconectados), rejilla de participantes con avatar/video, indicador de micrófono silenciado y de quién comparte pantalla. Si alguien se va, la llamada continúa entre los demás.
- **Únete a la llamada aunque no hayas entrado al principio** — si una llamada de grupo está en curso y no entraste (la rechazaste, abriste Nexo más tarde o cambiaste de pestaña), la llamada **sigue existiendo**: el chat del grupo muestra una barra «Llamada de grupo en curso · Unirse» con los participantes, la lista de chats marca el grupo con un indicador verde pulsante y un clic te mete en la llamada en marcha. El estado de la llamada vive en el broker como mensaje retenido con latido (se refresca cada minuto y caduca solo, así que nunca queda «fantasma»); al colgar el último participante desaparece para todos.
- **Llamada en segundo plano (estilo WhatsApp)** — minimiza la llamada con el botón ↓ y se abre una **ventana flotante siempre visible** (Document Picture-in-Picture, Chrome/Edge en escritorio) que **persiste mientras cambias de pestaña o de aplicación**: video remoto, cronómetro, silenciar, cámara, compartir pantalla y colgar — todo funciona desde la ventanita. Además, la Media Session API integra la llamada con el sistema (en Android aparece como medios en curso con botón de colgar) y el audio sigue sonando con la app en segundo plano. En navegadores sin ventana flotante se usa un banner interno verde con avatar, nombre y cronómetro (mismo comportamiento de audio). El título de la pestaña también muestra «en llamada».
- **Compartir pantalla en las llamadas** — botón de monitor en cualquier llamada (1:1 o grupo): comparte una ventana/pestaña/pantalla completa con todos los participantes a la vez (getDisplayMedia + replaceTrack en todas las conexiones). Las llamadas que empiezan sin cámara llevan una pista de video mínima para poder activar la cámara o la pantalla compartida en cualquier momento.
- **Fijar a una persona en la llamada (v7)** — en las llamadas de grupo, cada participante tiene un botón de **chincheta** en su tile (o doble clic sobre él): al fijarlo, su video ocupa toda la pantalla de la llamada y el resto pasa a una **tira de miniaturas arriba** (estilo WhatsApp/Meet). Tocar de nuevo la chincheta restaura la rejilla; si la persona fijada sale de la llamada, el foco se libera solo. Quien **comparte pantalla se enfoca automáticamente** (sin pisar nunca un fijado manual, y al dejar de compartir el foco se libera). En la **ventana flotante** (PiP) se muestra el video del participante fijado, y en llamadas **1:1** el botón de fijar oculta tu miniatura para ver solo a la otra persona.
- **Stickers** — crea tu propia galería: añade cualquier imagen (los PNG con transparencia quedan perfectos) desde el botón de sonrisa → «+». Se comprimen (WebP, hasta 320 px) y se guardan en tu dispositivo. Envíalos con un toque y se ven grandes, sin burbuja. Cualquier sticker que **recibas** puedes guardarlo en tus **favoritos** con el botón ★ que aparece sobre él (y luego enviarlo tú también).
- **Autor visible en cada mensaje de grupo** — todos los mensajes ajenos en grupos muestran avatar y nombre de quien los envió, con su color propio.
- **Funciones estilo WhatsApp (v6)** —
  - **Responder**: cita el mensaje original (barra de vista previa sobre el compositor y bloque de cita en la burbuja; tocar la cita salta al mensaje original con un destello). Funciona con texto, imágenes, voz y stickers, en chats 1:1 y grupos.
  - **Reacciones con emoji**: abre el menú de un mensaje (botón ⋮ al pasar el cursor, clic derecho o pulsación larga en móvil) y elige entre ❤️ 😂 👍 😮 😢 🙏 🔥. Los chips bajo la burbuja agregan cuántos reaccionaron y el tuyo va resaltado; tocar un chip pone/quita tu reacción. Se propagan por temas retenidos propios (`rx/` y `grx/`, 7 días): llegan incluso a quien estaba desconectado.
  - **Eliminar para todos**: borra tu propio mensaje y todos ven «Se eliminó este mensaje» (la eliminación viaja sobre el tema original retenido → también llega a los desconectados al reconectar).
  - **Copiar y reenviar**: copia el texto de cualquier mensaje al portapapeles y reenvíalo a cualquier chat o grupo con la etiqueta «Reenviado».
  - **Silenciar chats**: sin sonidos, ni toasts, ni notificaciones del navegador y **sin sonido en el push** (el Service Worker consulta la lista de silenciados en IndexedDB): los mensajes simplemente aparecen.
  - **Fijar chats**: ancla tus conversaciones importantes arriba de la lista (icono 📌 y campana tachada para los silenciados).
  - **Buscar en el chat**: lupa en la cabecera → filtra la conversación con resultados resaltados y contador.
  - **Selector de emojis**: botón de emoji en el compositor con 6 categorías (caras, gestos, corazones, animales, comida, actividad); inserta en la posición del cursor.
- **Foto del grupo (v6, v11)** — desde el modal de miembros, el **creador o un administrador** puede poner (o quitar) la foto del grupo: se comprime, se publica en el descriptor retenido del grupo y **todos los miembros la ven al instante** (lista, cabecera y modal), también al reconectar.
- **Modo enfoque (v6)** — botón de barra lateral en la cabecera del chat (o del juego): **oculta toda la barra lateral** para dejar solo la conversación/juego a pantalla completa; un botón flotante arriba a la izquierda la restaura. Se recuerda entre sesiones.
- **Sonido y vibración renovados (v6)** — banco de efectos WebAudio rediseñado (capas desafinadas, envolventes suaves y filtro): pop de envío, doble nota con destello al recibir, arpegio social, mini-destello de reacción, fanfarria al conectar la llamada, avisos de se une/sale, tono de llamada melódico de dos frases y colgado descendente. **Volumen ajustable** (0–100%) y **vibración** en móvil, todo en Ajustes con botón de demo.
- **Notificaciones con la app cerrada (Web Push real)** — cada usuario publica su suscripción push en el broker; cuando alguien te escribe y no puedes ver el mensaje, el navegador del remitente cifra la notificación (RFC 8291, aes128gcm), la firma con VAPID (RFC 8292) y la envía directamente a tu push service: te llega una notificación del sistema **aunque Nexo esté cerrado**, y al tocarla se abre el chat. El envío es inteligente (por acuse de recibo): si tu pestaña está viva y recibe el mensaje, no se envía push (ya te avisó la propia app); si está oculta, congelada o cerrada, el push se envía a los pocos segundos. Las notificaciones del mismo chat se agrupan en una sola (tag por chat) y no se duplican si estás viendo la app. En Ajustes puedes lanzar una **prueba real** que envía un push completo a tu propio dispositivo. En iPhone/iPad: instala Nexo en la pantalla de inicio (es una PWA con manifest e iconos) para recibirlas.
- **Sistema de notificaciones** — centro integrado (campana), notificaciones del navegador vía Service Worker (compatible con Android), sonidos sintetizados (WebAudio) y badges de no leídos.
- **Filtro anti-spam** — los mensajes detectados como spam (ráfagas, repeticiones, mayúsculas, enlaces, palabras sospechosas…) se entregan marcados en el chat, pero **no generan ninguna notificación**: ni sonido, ni aviso, ni badge, ni push. Sensibilidad configurable (baja/media/alta) y contador de spam bloqueado.
- **Personalización de tema y fondo** — elige el color de acento (presets o matiz libre; todo el sistema de diseño se recalcula) y el fondo del chat: 6 fondos predefinidos o una imagen propia desde tu dispositivo.
- **Apartado de Juegos** — botón de gamepad en la barra lateral con dos juegos que corren **dentro de Nexo**: **Emergency Strike** (acción táctica) y **Apex Kart** (carreras). Cada uno se abre en un escenario a pantalla casi completa (iframe) con cabecera propia para volver a tus chats o abrirlo en una pestaña nueva; tus conversaciones siguen a un clic de distancia.
- **Logo y diseño renovados** — marca v6: burbuja de chat blanca con la «N» teal y dos nodos de conexión (la esencia de un *nexo*: conectar personas) sobre degradado teal→esmeralda, con borde interior sutil; aplicada en la app, el favicon y los iconos de la PWA (incluido icono *maskable* con zona segura para los recortes circulares de Android). Además, pulido visual de la pantalla de acceso, barra lateral, listas, foco accesible y micro-animaciones.

## Arquitectura

| Capa | Tecnología | Uso |
|---|---|---|
| Tiempo real | MQTT sobre WSS (broker público HiveMQ, respaldo EMQX) | cuentas, perfiles (con foto), presencia, solicitudes, mensajes, grupos |
| Notificaciones offline | Web Push (Service Worker + VAPID + aes128gcm, todo firmado/cifrado en el cliente) | avisos con la app cerrada |
| Multimedia | WebRTC vía PeerJS (señalización pública) + MediaRecorder | llamadas y mensajes de voz |
| Cifrado de contraseñas | WebCrypto PBKDF2-SHA256 (60 000 iteraciones) | cuentas |
| Cifrado de la copia de seguridad | WebCrypto AES-GCM 256 + PBKDF2 (clave derivada de la contraseña) | chats/ajustes/multimedia respaldados en la red y en GitHub, legibles solo con la contraseña |
| Respaldo duradero | API de contenidos de GitHub (rama `nx-backups` del repositorio de la app) | espejo cifrado de la copia: lectura pública sin token, escritura con el PAT del usuario |
| Persistencia | localStorage + IndexedDB | sesión, amigos, grupos, historial (400 mensajes/conversación), imágenes, audios, fondo propio |

Espacios de temas (todos bajo `nexo/v1/`): `auth/<u>`, `profile/<u>` (nombre+foto+acerca de), `presence/<u>`, `psub/<u>` (suscripción push), `freq/<para>/<de>`, `fresp/<para>/<de>`, `dm/<para>/<de>/<idMensaje>[/fragmento]`, `evt/<u>` (también: invitaciones de llamada grupal, señalización de cámara/pantalla y acuses de recibo que cancelan los push diferidos), `group/<gid>` (descriptor con nombre, miembros y **foto del grupo**), `ginv/<u>/<gid>` (invitación retenida), `gm/<gid>/<autor>/<id>[/fragmento]` (mensajes de grupo, stickers incluidos; también llevan las eliminaciones «para todos»), `gm/<gid>/sys/<idMensaje>` (**mensajes de sistema del grupo**: añadidos, renombrados y expulsiones; retenidos 7 días), `gm/<gid>/sys/call` (eventos de llamada grupal: unirse/salir/medios), `gcall/<gid>` (estado retenido de la llamada de grupo en curso: participantes + latido), `rx/<para>/<autor>/<idMensaje>` y `grx/<gid>/<autor>/<idMensaje>` (**reacciones con emoji**, retenidas 7 días), y **`bk/<u>/dm` + `bk/<u>/d/<i>` + `bk/<u>/fm` + `bk/<u>/f/<idBlob>/<i>` (copia de seguridad cifrada: manifiestos + chunks de datos y multimedia, retenidos sin expiración, publicación QoS 1)**.

Nota de retención: los mensajes de grupo **no se borran del broker al recibirlos** (solo expiran a los 7 días) — así, con varios miembros, el primero en conectarse no roba la copia retenida del resto; la recepción es idempotente (deduplicación por id). El descriptor del grupo incluye `admins` (v11) y el registro de cada cuenta viaja también cifrado dentro de su copia de seguridad (`acct`).

## Cómo activar las notificaciones

1. Abre Nexo y pulsa **Activar** en el banner (o Ajustes → Notificaciones → *Notificaciones sin abrir la app*).
2. Permite las notificaciones del navegador.
3. Listo: recibirás avisos de mensajes, grupos, solicitudes y llamadas perdidas aunque cierres la app. El spam detectado nunca genera notificación.

Nota para iPhone/iPad: el sistema exige que la web esté **instalada en la pantalla de inicio** (Compartir → Añadir a inicio) para recibir notificaciones en segundo plano.

## Honestidad técnica (limitaciones)

- Los brokers públicos no autentican escrituras: **no es apto para datos sensibles**. Los payloads de push sí van cifrados de extremo a extremo (aes128gcm), pero el MQTT no. La copia de seguridad (red y GitHub) sí va cifrada con tu contraseña.
- Los brokers públicos **no garantizan la retención** (pueden purgar mensajes retenidos al reiniciarse) y el respaldo de emergencia cambia de broker si el principal tarda en responder: dos dispositivos pueden acabar en brokers distintos y no verse entre sí. El **respaldo duradero en GitHub (v11)** mitiga ambas cosas: la copia cifrada —incluida la cuenta— vive en tu repositorio y se restaura desde cualquier dispositivo con solo tu usuario y contraseña.
- El historial y la multimedia se sincronizan entre dispositivos **a través de la copia de seguridad** (máx. 400 mensajes por conversación y 200 elementos / 6 MB de multimedia): los cambios hechos sin conexión se fusionan al volver, pero la sincronización no es instantánea como en un servidor real.
- Las llamadas y la grabación de voz requieren que ambos usuarios estén en línea; sin servidor TURN, algunas redes corporativas muy restrictivas pueden bloquear WebRTC.
- Los mensajes offline se retienen 7 días como máximo; las suscripciones push se refrescan al abrir la app (caducan a 30 días).
- El par VAPID de la app vive en el cliente (no hay servidor): es la identidad de la app ante los push services, no un secreto de usuario.
- El PAT de GitHub se guarda sin cifrar en el `localStorage` del dispositivo que lo introduce (necesario para usarlo) y cifrado dentro de la copia de seguridad. Si un día lo revocas en GitHub, la lectura de la copia sigue funcionando (es pública) pero esos dispositivos dejarán de poder escribir el espejo hasta que conectes un token nuevo.

## Desarrollo local

```bash
cd Googledocss
python3 -m http.server 8080
# abre http://localhost:8080
```

Abre la app en dos ventanas/pestañas distintas, registra dos cuentas y pruébala: solicitud de amistad, aceptación, chat, grupos, imágenes, voz, llamadas, notificaciones (con y sin la pestaña abierta) y spam.

## Despliegue

Contenido estático: rama `main`, carpeta raíz, GitHub Pages activado. Sin pasos de compilación.
