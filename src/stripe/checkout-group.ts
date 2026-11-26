// ============================================================================
// Compra de varios pedidos a la vez (carrito)
// ============================================================================
// Cada producto del carrito sigue siendo su propio documento `orders/{id}` (el
// editor, la producción y los exportes trabajan por pedido). Al pagar, el
// checkout los enlaza con `checkoutGroup` y reparte el total entre ellos: el
// envío y el código de descuento van en el primero (el «principal»).
//
// Aquí vive la parte pura: leer los ids de la petición y comprobar que el grupo
// es cobrable. Sin Firestore ni Stripe, para poder testearlo.
// ============================================================================

/** Un pago de Stripe no debería cubrir más pedidos que esto (y la metadata cabe). */
export const MAX_GROUP_ORDERS = 20;

/**
 * Estados en los que un pedido NO se puede volver a cobrar. Lista negra y no
 * blanca a propósito: un estado nuevo imprevisto no debe romper el checkout.
 */
export const NON_PAYABLE_STATUSES = new Set([
  'paid',
  'mock_paid',
  'en_produccion',
  'enviado',
  'entregado',
]);

export class CheckoutGroupError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = 'CheckoutGroupError';
  }
}

/**
 * Ids de los pedidos a cobrar. Acepta `orderIds` (carrito) o `orderId` (pedido
 * suelto, el formato de siempre). El primero es el principal.
 */
export function parseOrderIds(body: { orderId?: unknown; orderIds?: unknown } | null | undefined): string[] {
  const raw: unknown[] = Array.isArray(body?.orderIds)
    ? body!.orderIds as unknown[]
    : body?.orderId !== undefined ? [body.orderId] : [];

  const ids: string[] = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (!id || id.includes('/') || id.length > 128) {
      throw new CheckoutGroupError(400, 'Identificador de pedido no válido');
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw new CheckoutGroupError(400, 'Falta orderId');
  if (ids.length > MAX_GROUP_ORDERS) {
    throw new CheckoutGroupError(400, `Un pago puede cubrir como máximo ${MAX_GROUP_ORDERS} productos`);
  }
  return ids;
}

/** Ids guardados en la metadata de Stripe (`orderIds` separados por comas, o `orderId`). */
export function orderIdsFromMetadata(metadata: Record<string, string> | null | undefined): string[] {
  const list = String(metadata?.orderIds || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (list.length > 0) return Array.from(new Set(list));
  const single = String(metadata?.orderId || '').trim();
  return single ? [single] : [];
}

export interface GroupLine {
  orderId: string;
  name: string;
  /** Importe del pedido en unidades menores (COP × 100). */
  amountMinor: number;
}

export interface ValidatedGroup {
  leadOrderId: string;
  orderIds: string[];
  lines: GroupLine[];
  totalMinor: number;
}

/** Nombre legible de la línea en la página de pago de Stripe. */
export function lineName(order: Record<string, any>, fallback = 'Pedido Jiffy'): string {
  const s = order?.paymentSummary;
  const base = String(s?.productLabel || order?.product?.name || fallback).trim() || fallback;
  const size = s?.size ? ` ${String(s.size).trim()}` : '';
  const qty = Number(order?.quantity ?? s?.quantity) || 1;
  return `${base}${size}${qty > 1 ? ` × ${qty}` : ''}`.slice(0, 250);
}

/**
 * Comprueba que todos los pedidos existen, son del usuario, se pueden cobrar y
 * —si son varios— que el checkout los enlazó en el MISMO grupo. Así nadie puede
 * colar en su pago un pedido que no pasó por el checkout con los demás.
 */
export function validateGroup(
  ids: string[],
  orders: Array<Record<string, any> | null | undefined>,
  uid: string,
): ValidatedGroup {
  const lines: GroupLine[] = [];
  let groupId: string | null = null;

  ids.forEach((id, i) => {
    const order = orders[i];
    if (!order) throw new CheckoutGroupError(404, 'El pedido no existe');
    if (order.userId !== uid) throw new CheckoutGroupError(403, 'El pedido no te pertenece');
    if (NON_PAYABLE_STATUSES.has(order.status)) {
      throw new CheckoutGroupError(409, `El pedido ya está en estado "${order.status}" y no admite un nuevo pago`);
    }

    const total = Number(order.total);
    if (!Number.isFinite(total) || total < 0) {
      throw new CheckoutGroupError(400, 'El pedido no tiene un total válido. Vuelve al checkout y confirma la dirección.');
    }

    if (ids.length > 1) {
      const g = order.checkoutGroup;
      const sameSet = Array.isArray(g?.orderIds)
        && g.orderIds.length === ids.length
        && ids.every(x => g.orderIds.includes(x));
      if (!g?.id || !sameSet || (groupId !== null && g.id !== groupId)) {
        throw new CheckoutGroupError(409, 'El carrito cambió. Vuelve al checkout y confirma de nuevo.');
      }
      groupId = g.id;
    }

    lines.push({ orderId: id, name: lineName(order), amountMinor: Math.round(total * 100) });
  });

  const totalMinor = lines.reduce((n, l) => n + l.amountMinor, 0);
  if (totalMinor <= 0) {
    throw new CheckoutGroupError(400, 'El pedido no tiene un total válido. Vuelve al checkout y confirma la dirección.');
  }

  return { leadOrderId: ids[0], orderIds: ids, lines, totalMinor };
}
