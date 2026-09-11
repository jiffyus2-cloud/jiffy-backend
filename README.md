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
| `ONECLIC_API_KEY` | — | Clave de 1clic.ai. Sin ella los endpoints `/ai/*` responden 500. |

## Desarrollo

```bash
npm install
npm run build
npm run start
```

No hay infraestructura de tests todavía.
