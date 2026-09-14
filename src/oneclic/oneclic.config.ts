/**
 * Configuración del módulo de conexión con 1clic.ai.
 *
 * Todo sale del entorno, nada del repo:
 *
 * - `ONECLIC_API_KEY`: la clave que devuelve `POST /api/v1/keys/provision`.
 *   Es el ÚNICO secreto del módulo. `VITE_1CLIC_API_KEY` se acepta como
 *   respaldo porque es el nombre que ya leía `AiService`.
 * - `ONECLIC_CONNECTION_ID`: el id de la conexión. NO es un secreto (1clic lo
 *   publica en su manifiesto), pero se lee del entorno porque nombra UNA
 *   conexión: un build de staging con el id de producción escribiría eventos
 *   en la conexión equivocada sin que nada falle.
 * - `ONECLIC_API_URL`: base de la API, por si algún día cambia de host.
 */

export interface OneclicConfig {
  apiKey: string | null;
  connectionId: string | null;
  apiUrl: string;
}

export const ONECLIC_API_KEY_ENV = 'ONECLIC_API_KEY';
export const ONECLIC_CONNECTION_ID_ENV = 'ONECLIC_CONNECTION_ID';

export function readOneclicConfig(env: NodeJS.ProcessEnv = process.env): OneclicConfig {
  const apiKey = (env[ONECLIC_API_KEY_ENV] || env.VITE_1CLIC_API_KEY || '').trim();
  const connectionId = (env[ONECLIC_CONNECTION_ID_ENV] || '').trim();
  const apiUrl = (env.ONECLIC_API_URL || 'https://www.1clic.ai/api/v1').replace(/\/+$/, '');

  return {
    apiKey: apiKey || null,
    connectionId: connectionId || null,
    apiUrl,
  };
}
