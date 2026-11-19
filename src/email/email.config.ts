/**
 * Configuración de los correos masivos. Todo sale del entorno; nada es
 * obligatorio para que el servidor arranque: si falta algo, `/email/*`
 * responde 503 explicando qué falta y el resto de la API sigue igual.
 *
 * - `EMAIL_PROVIDER`            proveedor (`resend` por defecto; único implementado).
 * - `EMAIL_PROVIDER_API_KEY`    clave del proveedor. **Secreta.**
 * - `EMAIL_FROM`                remitente, p. ej. `Jiffy Photos <hola@jiffyphotos.com>`.
 *                               El dominio debe estar verificado (SPF/DKIM) en el proveedor.
 * - `EMAIL_REPLY_TO`            opcional: a dónde van las respuestas.
 * - `EMAIL_UNSUBSCRIBE_SECRET`  firma los enlaces de baja. **Secreta.** Si se
 *                               cambia, los enlaces de correos ya enviados dejan de valer.
 * - `EMAIL_PUBLIC_BASE_URL`     URL pública de este backend (para el enlace de baja).
 *                               Si no se define se deduce de la petición.
 * - `EMAIL_POSTAL_ADDRESS`      opcional: dirección física que aparece en el pie
 *                               (la pide CAN-SPAM para envíos a EE. UU.).
 */
export interface EmailConfig {
  provider: string;
  apiKey: string;
  from: string;
  replyTo: string;
  unsubscribeSecret: string;
  publicBaseUrl: string;
  postalAddress: string;
}

export function readEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  return {
    provider: (env.EMAIL_PROVIDER || 'resend').trim().toLowerCase(),
    apiKey: (env.EMAIL_PROVIDER_API_KEY || '').trim(),
    from: (env.EMAIL_FROM || '').trim(),
    replyTo: (env.EMAIL_REPLY_TO || '').trim(),
    unsubscribeSecret: (env.EMAIL_UNSUBSCRIBE_SECRET || '').trim(),
    publicBaseUrl: (env.EMAIL_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
    postalAddress: (env.EMAIL_POSTAL_ADDRESS || '').trim(),
  };
}

/** Nombres de las variables que faltan para poder enviar (nunca sus valores). */
export function missingEmailConfig(config: EmailConfig): string[] {
  const missing: string[] = [];
  if (!config.apiKey) missing.push('EMAIL_PROVIDER_API_KEY');
  if (!config.from) missing.push('EMAIL_FROM');
  if (!config.unsubscribeSecret) missing.push('EMAIL_UNSUBSCRIBE_SECRET');
  return missing;
}
