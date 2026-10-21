import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Token de baja: `v1.<uid en base64url>.<HMAC-SHA256>`. No caduca (un enlace
 * de baja tiene que seguir funcionando en un correo de hace un año) y no
 * permite nada más que marcar `emailOptOut` en ese usuario.
 */
const VERSION = 'v1';

function sign(uid: string, secret: string): string {
  return createHmac('sha256', secret).update(`unsubscribe:${VERSION}:${uid}`).digest('base64url');
}

export function createUnsubscribeToken(uid: string, secret: string): string {
  if (!secret) throw new Error('Falta EMAIL_UNSUBSCRIBE_SECRET');
  return `${VERSION}.${Buffer.from(uid, 'utf8').toString('base64url')}.${sign(uid, secret)}`;
}

/** Devuelve el uid si la firma es válida; `null` en cualquier otro caso. */
export function verifyUnsubscribeToken(token: string, secret: string): string | null {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;

  let uid: string;
  try {
    uid = Buffer.from(parts[1], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!uid || uid.length > 128 || uid.includes('/')) return null;

  const expected = Buffer.from(sign(uid, secret));
  const presented = Buffer.from(parts[2]);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
  return uid;
}
