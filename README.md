# jiffy-backend

API en NestJS que da servicio a la tienda Jiffy: creación de sesiones de pago en
Stripe, webhook de confirmación y proxy a los agentes de IA de 1clic.ai.

Los álbumes y pedidos **no** se guardan aquí: el frontend escribe directamente en
Firestore y Storage. Este servicio solo interviene en el pago y en la IA.

## Endpoints

| Método | Ruta | Auth | Para qué |
|---|---|---|---|
| `GET` | `/` | — | Comprobación de vida |
| `POST` | `/stripe/create-checkout` | ID token de Firebase | Crea la sesión de pago de un pedido |
| `POST` | `/stripe/webhook` | Firma de Stripe | Marca el pedido como `paid` |
| `POST` | `/ai/support-chat` | — | Chat de soporte |
| `GET` | `/oneclic/status` | ID token del dueño | Estado de la conexión con 1clic.ai y agentes disponibles |
| `POST` | `/oneclic/propose` | ID token del dueño | Pide una propuesta a un agente de 1clic sobre un registro |
| `POST` | `/oneclic/verify` | ID token del dueño | Ejecuta la prueba de conformidad de 1clic desde la plataforma |

`create-checkout` recibe un `orderId` y toma el importe del pedido en Firestore.
El `amount` que envíe el cliente se ignora a efectos de cobro.

## Variables de entorno

El servidor **no arranca** si falta algo de lo obligatorio: es preferible que
falle el despliegue a que quede en pie aceptando peticiones que no puede
autorizar. Todas admiten también el prefijo `VITE_` por compatibilidad con el
entorno existente.

### Obligatorias

| Variable | Para qué |
|---|---|
| `STRIPE_SECRET_KEY` | Clave secreta de Stripe. Sin ella el proceso sale con código 1. |
| `STRIPE_WEBHOOK_SECRET` | Verifica la firma del webhook. Sin ella el webhook rechaza todo. |

### Credenciales de Firebase

Hacen falta para verificar los ID token y leer los pedidos. Dos formas, por orden
de preferencia:

1. **Cuenta de servicio adjunta** (lo habitual en Cloud Run): no hay que
   configurar nada, se usan las Application Default Credentials.
2. **Explícitas**, las tres a la vez:
   `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
   Los saltos de línea de la clave privada pueden ir escapados como `\n`.

En local también sirve apuntar `GOOGLE_APPLICATION_CREDENTIALS` a un JSON de
cuenta de servicio.

### Opcionales

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `8080` | Puerto de escucha |
| `FRONTEND_URL` | `http://localhost:5173` | Base de las URLs de retorno de Stripe |
| `ALLOWED_ORIGINS` | — | Lista de orígenes CORS separada por comas. Si no se define se usa `FRONTEND_URL` más los puertos de desarrollo; si tampoco hay `FRONTEND_URL`, CORS queda abierto y se avisa por consola. **Conviene definirla en producción.** |
| `ONECLIC_API_KEY` | — | Clave de 1clic.ai (la que devuelve `POST /api/v1/keys/provision`, prefijo `1cg_`). Sin ella `/ai/*` responde 500 y `/oneclic/*` responde 503. **Nunca en el repo ni en un log.** |
| `ONECLIC_CONNECTION_ID` | — | Id de la conexión de 1clic que nombra este despliegue. No es secreto, pero va en el entorno para que staging no escriba en la conexión de producción. |
| `OWNER_EMAIL` | `jiffyus2@gmail.com` | Correo que `OwnerGuard` acepta para `/oneclic/*` (mismo criterio que `isOwner()` en las reglas de Firestore). |

## Desarrollo

```bash
npm install
npm run build
npm run start
```

```bash
npm test   # compila y corre los tests de node:test sobre dist/
```

De momento solo hay tests para `src/oneclic` (reglas de reintento, sondeo e
idempotencia del cliente de 1clic).

## Conexión con 1clic.ai (`src/oneclic`)

Módulo aislado: no depende de ningún otro y ninguno depende de él. El navegador
nunca ve la clave; el panel del dueño (pestaña *Conexiones* del dashboard) habla
con `/oneclic/*` y este servicio con 1clic.

- `oneclic.client.ts`: cliente HTTP con las reglas que 1clic observa —
  `Bearer` en todo salvo `agent_connected`, `Idempotency-Key` en cada run,
  sondeo 2 s → 5 s → 10 s, un solo reintento tras `Retry-After` en 429, y
  nunca reintentar un 402.
- `oneclic.service.ts`: `external_user_id` como hash estable del uid (nunca un
  correo), `response_schema` para consumir JSON, y la verificación (paso D).
- `scripts/oneclic-install-key.sh <código>` (Cloud Shell): canjea un código de
  configuración e instala la clave en Cloud Run sin imprimirla. Sirve para el
  alta y para la rotación a los 90 días.
- El 403 `agent_not_allowed` **no es un fallo**: la clave vale y solo falta que
  el dueño asigne un agente en 1clic. `GET /oneclic/status` lo muestra tal cual.

## Gestión de almacenamiento (`src/storage`)

Da servicio a la pestaña "Gestión de almacenamiento" del panel del dueño.

- **Política** (`settings/storage_policy`): `maxDraftsPerUser` (borradores
  simultáneos por usuario), `draftRetentionDays` (días sin editar tras los
  cuales un borrador se borra) y `storageCapacityGb` (capacidad de referencia
  para calcular el "disponible"). La escribe el panel directamente en Firestore;
  el backend solo la lee. Los valores iniciales del código (5 / 90 / 5) rigen
  únicamente mientras no exista el documento y nunca se escriben desde aquí.
- **`GET /storage/stats`** recorre el bucket con el SDK de administrador y cruza
  las carpetas `orders/{uid}/{orderId}/` con Firestore. Distingue borradores,
  pedidos, imágenes de la tienda, **carpetas huérfanas** (sin pedido en
  Firestore y sin escrituras en las últimas 24 h; `deleteSavedDraft` del
  frontend borra el documento pero no las fotos) y **subidas en curso** (sin
  pedido todavía, pero con escrituras recientes: `createDraftOrder` sube las
  fotos antes de crear el documento). Se cachea 5 minutos en memoria.
- **`POST /storage/cleanup`** borra los borradores (`draft`, `saved_draft`)
  cuya última edición —o última subida a Storage, la más reciente de las dos—
  es anterior a `hoy − draftRetentionDays`, junto con su carpeta. **Solo vencen
  los borradores creados después de `retentionAppliesFrom`**, la fecha en que
  el dueño activó la caducidad (la fija el panel al guardar la política por
  primera vez); los anteriores no se tocan nunca, y sin esa fecha no vence
  ninguno. Un borrador sin fecha tampoco. Las carpetas huérfanas solo se borran
  con `orphans: true` explícito. Una carpeta a la que apunten las fotos de
  cualquier pedido vivo (un borrador creado a partir de otro reutiliza sus
  fotos; los pedidos antiguos guardaban las fotos bajo otro id) **nunca** se
  borra ni cuenta como huérfana, aunque su propio documento caduque.
  `dryRun: true` solo informa.
  El resumen de la última ejecución real queda en `settings/storage_status`.

### Limpieza programada

Cloud Run escala a cero, así que un cron dentro del proceso no sirve. Se usa
Cloud Scheduler llamando a `POST /storage/cleanup` con el header
`x-cleanup-token`:

```bash
export STORAGE_CLEANUP_TOKEN="$(openssl rand -hex 32)"
bash scripts/gcp/env-set.sh jiffy-backend STORAGE_CLEANUP_TOKEN="$STORAGE_CLEANUP_TOKEN"
bash scripts/gcp/scheduler-cleanup.sh   # crea/actualiza el job diario (03:00 Bogotá)
```

(los dos scripts viven en el repo del frontend, `scripts/gcp/`). El job se
puede probar a mano con `bash scripts/gcp/scheduler-cleanup.sh --run`.
