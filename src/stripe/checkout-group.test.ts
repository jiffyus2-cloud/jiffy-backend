import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  CheckoutGroupError,
  MAX_GROUP_ORDERS,
  lineName,
  orderIdsFromMetadata,
  parseOrderIds,
  validateGroup,
} from './checkout-group';

// Se ejecutan sobre el JS compilado (ver el script `test` de package.json).

const group = (ids: string[], id = 'g1') => ({ id, orderIds: ids, leadOrderId: ids[0] });

function order(over: Record<string, any> = {}) {
  return { userId: 'u1', status: 'pending_payment', total: 100000, product: { name: 'Álbum' }, ...over };
}

function errStatus(fn: () => unknown): number | null {
  try { fn(); return null; } catch (e) {
    assert.ok(e instanceof CheckoutGroupError);
    return (e as CheckoutGroupError).status;
  }
}

describe('parseOrderIds', () => {
  it('acepta el formato de siempre (orderId)', () => {
    assert.deepEqual(parseOrderIds({ orderId: 'abc' }), ['abc']);
  });
  it('prefiere orderIds, quita duplicados y conserva el orden', () => {
    assert.deepEqual(parseOrderIds({ orderId: 'x', orderIds: ['b', 'a', 'b'] }), ['b', 'a']);
  });
  it('rechaza vacíos, rutas y listas demasiado largas', () => {
    assert.equal(errStatus(() => parseOrderIds({})), 400);
    assert.equal(errStatus(() => parseOrderIds({ orderIds: [] })), 400);
    assert.equal(errStatus(() => parseOrderIds({ orderIds: ['a/b'] })), 400);
    assert.equal(errStatus(() => parseOrderIds({ orderIds: [42] })), 400);
    const many = Array.from({ length: MAX_GROUP_ORDERS + 1 }, (_, i) => `o${i}`);
    assert.equal(errStatus(() => parseOrderIds({ orderIds: many })), 400);
  });
});

describe('orderIdsFromMetadata', () => {
  it('lee la lista del carrito', () => {
    assert.deepEqual(orderIdsFromMetadata({ orderId: 'a', orderIds: 'a,b, c' }), ['a', 'b', 'c']);
  });
  it('cae al orderId de las sesiones antiguas', () => {
    assert.deepEqual(orderIdsFromMetadata({ orderId: 'a' }), ['a']);
    assert.deepEqual(orderIdsFromMetadata({}), []);
    assert.deepEqual(orderIdsFromMetadata(null), []);
  });
});

describe('validateGroup', () => {
  it('un pedido suelto no necesita grupo', () => {
    const g = validateGroup(['a'], [order()], 'u1');
    assert.equal(g.leadOrderId, 'a');
    assert.equal(g.totalMinor, 10_000_000);
    assert.equal(g.lines.length, 1);
  });

  it('suma los pedidos del mismo grupo', () => {
    const ids = ['a', 'b'];
    const g = validateGroup(ids, [
      order({ total: 120000, checkoutGroup: group(ids) }),
      order({ total: 80000, checkoutGroup: group(ids) }),
    ], 'u1');
    assert.equal(g.totalMinor, 20_000_000);
    assert.deepEqual(g.lines.map(l => l.amountMinor), [12_000_000, 8_000_000]);
  });

  it('permite un pedido en 0 si el grupo suma algo (descuento que lo cubre)', () => {
    const ids = ['a', 'b'];
    const g = validateGroup(ids, [
      order({ total: 50000, checkoutGroup: group(ids) }),
      order({ total: 0, checkoutGroup: group(ids) }),
    ], 'u1');
    assert.equal(g.totalMinor, 5_000_000);
  });

  it('rechaza pedidos ajenos, inexistentes o ya pagados', () => {
    assert.equal(errStatus(() => validateGroup(['a'], [null], 'u1')), 404);
    assert.equal(errStatus(() => validateGroup(['a'], [order({ userId: 'otro' })], 'u1')), 403);
    assert.equal(errStatus(() => validateGroup(['a'], [order({ status: 'paid' })], 'u1')), 409);
    assert.equal(errStatus(() => validateGroup(['a'], [order({ total: 0 })], 'u1')), 400);
    assert.equal(errStatus(() => validateGroup(['a'], [order({ total: 'x' })], 'u1')), 400);
  });

  it('rechaza mezclar pedidos que el checkout no enlazó juntos', () => {
    const ids = ['a', 'b'];
    // Sin grupo
    assert.equal(errStatus(() => validateGroup(ids, [order(), order()], 'u1')), 409);
    // Grupos distintos
    assert.equal(errStatus(() => validateGroup(ids, [
      order({ checkoutGroup: group(ids, 'g1') }),
      order({ checkoutGroup: group(ids, 'g2') }),
    ], 'u1')), 409);
    // El grupo guardado tiene otros pedidos
    assert.equal(errStatus(() => validateGroup(ids, [
      order({ checkoutGroup: group(['a', 'b', 'c']) }),
      order({ checkoutGroup: group(['a', 'b', 'c']) }),
    ], 'u1')), 409);
  });
});

describe('lineName', () => {
  it('usa el desglose del checkout y la cantidad', () => {
    assert.equal(
      lineName({ quantity: 2, paymentSummary: { productLabel: 'Álbum', size: '20x20 cm' } }),
      'Álbum 20x20 cm × 2',
    );
    assert.equal(lineName({ product: { name: 'Calendario' } }), 'Calendario');
    assert.equal(lineName({}), 'Pedido Jiffy');
  });
});
