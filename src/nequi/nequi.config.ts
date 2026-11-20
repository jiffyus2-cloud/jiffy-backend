/**
 * Configuración del cobro con Nequi (API Nequi Conecta, pagos push).
 *
 * Todo sale del entorno, nada del repo. Si falta cualquiera de las tres
 * credenciales el módulo arranca "apagado": `GET /nequi/config` responde
 * `enabled: false`, el checkout no muestra la opción y el resto del backend
 * (Stripe incluido) sigue funcionando igual.
 *
 * - `NEQUI_CLIENT_ID` / `NEQUI_CLIENT_SECRET`: credenciales OAuth de Conecta.
 * - `NEQUI_API_KEY`: la API key de Conecta (header `x-api-key`).
 * - `NEQUI_COMMERCE_CODE`: el código de comercio que asigna Nequi (campo `code`
 *   de cada petición; en sandbox suele ser algo como `NIT_1`). Sin él no se
 *   puede cobrar, así que también cuenta como obligatorio.
 * - `NEQUI_ENV`: `sandbox` (por defecto) o `production`. Por defecto sandbox a
 *   propósito: equivocarse hacia el entorno de pruebas no cobra a nadie.
 * - `NEQUI_RECONCILE_SECRET`: opcional. Activa `POST /nequi/reconcile`, que un
 *   Cloud Scheduler llama cada pocos minutos para cerrar pedidos cuyo cliente
 *   aceptó el pago y cerró la pestaña antes de que el navegador se enterara.
 */

export type NequiEnv = 'sandbox' | 'production';

export interface NequiConfig {
  clientId: string | null;
  clientSecret: string | null;
  apiKey: string | null;
  commerceCode: string | null;
  env: NequiEnv;
  apiBase: string;
  authUrl: string;
  reconcileSecret: string | null;
}

const URLS: Record<NequiEnv, { apiBase: string; authUrl: string }> = {
  sandbox: {
    apiBase: 'https://api.sandbox.nequi.com',
    authUrl: 'https://oauth.sandbox.nequi.com/oauth2/token',
  },
  production: {
    apiBase: 'https://api.nequi.com',
    authUrl: 'https://oauth.nequi.com/oauth2/token',
  },
};

export function readNequiConfig(env: NodeJS.ProcessEnv = process.env): NequiConfig {
  const pick = (name: string) => (env[name] || '').trim() || null;
  const nequiEnv: NequiEnv = (env.NEQUI_ENV || '').trim().toLowerCase() === 'production'
    ? 'production'
    : 'sandbox';

  return {
    clientId: pick('NEQUI_CLIENT_ID'),
    clientSecret: pick('NEQUI_CLIENT_SECRET'),
    apiKey: pick('NEQUI_API_KEY'),
    commerceCode: pick('NEQUI_COMMERCE_CODE'),
    env: nequiEnv,
    // Se pueden sobreescribir por si Nequi cambia de host; normalmente no hace falta.
    apiBase: (pick('NEQUI_API_BASE') || URLS[nequiEnv].apiBase).replace(/\/+$/, ''),
    authUrl: pick('NEQUI_AUTH_URL') || URLS[nequiEnv].authUrl,
    reconcileSecret: pick('NEQUI_RECONCILE_SECRET'),
  };
}

export function isNequiConfigured(config: NequiConfig): boolean {
  return Boolean(config.clientId && config.clientSecret && config.apiKey && config.commerceCode);
}
