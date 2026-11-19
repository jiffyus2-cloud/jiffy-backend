/**
 * Resolución de destinatarios a partir de la colección `users`.
 *
 * Funciones puras (sin Firestore) para poder probarlas; el servicio les pasa
 * los documentos ya leídos.
 */
export type EmailSegment = 'all' | 'with_orders' | 'without_orders';

export const EMAIL_SEGMENTS: EmailSegment[] = ['all', 'with_orders', 'without_orders'];

/**
 * Estados que cuentan como "ha comprado". Los borradores y los pagos
 * pendientes no: un usuario que dejó el carrito a medias es "sin pedidos".
 * `mock_paid` es un pedido cerrado sin cobro (p. ej. descuento del 100 %).
 */
export const PURCHASED_STATUSES = new Set(['paid', 'mock_paid', 'en_produccion', 'enviado', 'entregado']);

export interface UserDoc {
  uid: string;
  name?: string;
  email?: string;
  emailOptOut?: boolean;
}

export interface Recipient {
  uid: string;
  name: string;
  email: string;
}

export interface Audience {
  segment: EmailSegment;
  totalUsers: number;
  inSegment: number;
  optedOut: number;
  invalidEmail: number;
  duplicates: number;
  recipients: Recipient[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254;
}

export function isEmailSegment(value: unknown): value is EmailSegment {
  return typeof value === 'string' && (EMAIL_SEGMENTS as string[]).includes(value);
}

export function resolveAudience(users: UserDoc[], buyers: Set<string>, segment: EmailSegment): Audience {
  const audience: Audience = {
    segment,
    totalUsers: users.length,
    inSegment: 0,
    optedOut: 0,
    invalidEmail: 0,
    duplicates: 0,
    recipients: [],
  };
  const seen = new Set<string>();

  for (const user of users) {
    const bought = buyers.has(user.uid);
    if (segment === 'with_orders' && !bought) continue;
    if (segment === 'without_orders' && bought) continue;
    audience.inSegment++;

    if (user.emailOptOut === true) { audience.optedOut++; continue; }

    const email = String(user.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) { audience.invalidEmail++; continue; }
    if (seen.has(email)) { audience.duplicates++; continue; }
    seen.add(email);

    audience.recipients.push({ uid: user.uid, name: String(user.name || '').trim(), email });
  }
  return audience;
}

/**
 * Uid del comprador de un pedido. Los pedidos actuales viven en `orders/{id}`
 * con `userId`; los antiguos en `users/{uid}/orders/{id}` (el uid sale de la ruta).
 */
export function orderOwnerUid(path: string, data: { userId?: unknown }): string | null {
  if (typeof data.userId === 'string' && data.userId) return data.userId;
  const match = /^users\/([^/]+)\/orders\//.exec(path);
  return match ? match[1] : null;
}
