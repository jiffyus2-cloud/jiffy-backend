import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  NequiApiError,
  NequiAuthError,
  isAmbiguousSendFailure,
  NequiClient,
  NequiNotConfiguredError,
  mapNequiStatus,
  normalizeNequiPhone,
} from './nequi.client';
import { isNequiConfigured, readNequiConfig } from './nequi.config';
import { maskPhone, nequiRecordKey, recordOrderIds } from './nequi.service';

// Se ejecutan sobre el JS compilado (ver el script `test` de package.json).

const ENV = {
  NEQUI_CLIENT_ID: 'cid',
  NEQUI_CLIENT_SECRET: 'secret',
  NEQUI_API_KEY: 'key',
  NEQUI_COMMERCE_CODE: 'NIT_1',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function ok(any: unknown, code = '0', desc = 'SUCCESS') {
  return jsonResponse(200, {
    ResponseMessage: {
      ResponseHeader: { Channel: 'PNP04-C001', Status: { StatusCode: code, StatusDesc: desc } },
      ResponseBody: { any },
    },
  });
}

const TOKEN = () => jsonResponse(200, { access_token: 'tok', token_type: 'bearer', expires_in: 3600 });

function fakeFetch(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`fetch inesperado: ${url}`);
    return next;
  };
  return { impl, calls };
}

describe('configuración', () => {
  it('sin credenciales queda apagado y por defecto apunta a sandbox', () => {
    const cfg = readNequiConfig({});
    assert.equal(isNequiConfigured(cfg), false);
    assert.equal(cfg.env, 'sandbox');
    assert.equal(cfg.authUrl, 'https://oauth.sandbox.nequi.com/oauth2/token');
  });

  it('producción solo si se pide explícitamente', () => {
    const cfg = readNequiConfig({ ...ENV, NEQUI_ENV: 'Production' });
    assert.equal(isNequiConfigured(cfg), true);
    assert.equal(cfg.apiBase, 'https://api.nequi.com');
    assert.equal(readNequiConfig({ ...ENV, NEQUI_ENV: 'prod' }).env, 'sandbox');
  });

  it('el código de comercio es obligatorio', () => {
    const { NEQUI_COMMERCE_CODE, ...rest } = ENV;
    assert.equal(isNequiConfigured(readNequiConfig(rest)), false);
  });
});

describe('reglas puras', () => {
  it('normaliza celulares colombianos', () => {
    assert.equal(normalizeNequiPhone('300 123 4567'), '3001234567');
    assert.equal(normalizeNequiPhone('+57 300-123-4567'), '3001234567');
    assert.equal(normalizeNequiPhone('573001234567'), '3001234567');
    assert.equal(normalizeNequiPhone('6012345678'), null); // fijo
    assert.equal(normalizeNequiPhone('30012345'), null);
    assert.equal(normalizeNequiPhone(3001234567 as any), null);
  });

  it('traduce los estados de Nequi y nunca da por pagado un código desconocido', () => {
    assert.equal(mapNequiStatus('35'), 'paid');
    assert.equal(mapNequiStatus('33'), 'pending');
    assert.equal(mapNequiStatus('10-454'), 'expired');
    assert.equal(mapNequiStatus('10-455'), 'rejected');
    assert.equal(mapNequiStatus('71'), 'failed');
    assert.equal(mapNequiStatus('99'), 'pending');
    assert.equal(mapNequiStatus(undefined), 'pending');
  });

  it('enmascara el celular', () => {
    assert.equal(maskPhone('3001234567'), '300 *** 4567');
  });
});

describe('NequiClient', () => {
  it('sin configurar no hace ninguna llamada', async () => {
    const f = fakeFetch([]);
    const client = new NequiClient(readNequiConfig({}), f.impl);
    await assert.rejects(client.getPaymentStatus('x'), NequiNotConfiguredError);
    assert.equal(f.calls.length, 0);
  });

  it('pide token con Basic auth y envía el cobro con el sobre de Nequi', async () => {
    const f = fakeFetch([TOKEN(), ok({ unregisteredPaymentRS: { transactionId: ' tx-1 ' } })]);
    const client = new NequiClient(readNequiConfig(ENV), f.impl, () => Date.parse('2026-11-18T12:00:00Z'));

    const res = await client.sendPushPayment({ phoneNumber: '3001234567', value: 152000.4, reference1: 'order-1' });
    assert.equal(res.transactionId, 'tx-1');

    const [auth, pay] = f.calls;
    assert.equal(auth.url, 'https://oauth.sandbox.nequi.com/oauth2/token?grant_type=client_credentials');
    assert.equal((auth.init!.headers as any).Authorization, `Basic ${Buffer.from('cid:secret').toString('base64')}`);

    assert.equal(pay.url, 'https://api.sandbox.nequi.com/payments/v2/-services-paymentservice-unregisteredpayment');
    const headers = pay.init!.headers as any;
    assert.equal(headers.Authorization, 'Bearer tok');
    assert.equal(headers['x-api-key'], 'key');

    const body = JSON.parse(String(pay.init!.body));
    const header = body.RequestMessage.RequestHeader;
    assert.equal(header.Channel, 'PNP04-C001');
    assert.equal(header.ClientID, 'cid');
    assert.equal(header.Destination.ServiceOperation, 'unregisteredPayment');
    assert.equal(header.RequestDate, '2026-11-18T12:00:00.000Z');
    assert.match(header.MessageID, /^[0-9a-f]{10}$/);
    assert.deepEqual(body.RequestMessage.RequestBody.any.unregisteredPaymentRQ, {
      phoneNumber: '3001234567',
      code: 'NIT_1',
      value: '152000',
      reference1: 'order-1',
    });
  });

  it('reutiliza el token mientras no caduque', async () => {
    const f = fakeFetch([TOKEN(), ok({ getStatusPaymentRS: { status: '33' } }), ok({ getStatusPaymentRS: { status: '35', value: '1000', trnId: 'T' } })]);
    const client = new NequiClient(readNequiConfig(ENV), f.impl);
    assert.equal((await client.getPaymentStatus('tx')).state, 'pending');
    const second = await client.getPaymentStatus('tx');
    assert.equal(second.state, 'paid');
    assert.equal(second.value, 1000);
    assert.equal(second.trnId, 'T');
    assert.equal(f.calls.length, 3);
    assert.deepEqual(JSON.parse(String(f.calls[2].init!.body)).RequestMessage.RequestBody.any, {
      getStatusPaymentRQ: { codeQR: 'tx' },
    });
  });

  it('un StatusCode distinto de 0 es un error con la descripción de Nequi', async () => {
    const f = fakeFetch([TOKEN(), ok({}, '20-07A', 'El usuario no tiene Nequi')]);
    const client = new NequiClient(readNequiConfig(ENV), f.impl);
    await assert.rejects(
      client.sendPushPayment({ phoneNumber: '3001234567', value: 1000 }),
      (err: any) => err instanceof NequiApiError && err.statusCode === '20-07A' && /no tiene Nequi/.test(err.message),
    );
  });

  it('si el token falla no se llama a la API', async () => {
    const f = fakeFetch([jsonResponse(401, { error: 'invalid_client' })]);
    const client = new NequiClient(readNequiConfig(ENV), f.impl);
    await assert.rejects(client.getPaymentStatus('tx'), NequiApiError);
    assert.equal(f.calls.length, 1);
  });
});

describe('reversión', () => {
  it('reversa con el MessageID del cobro original, el celular y el valor', async () => {
    const f = fakeFetch([TOKEN(), ok({ reversionRS: '' })]);
    const client = new NequiClient(readNequiConfig(ENV), f.impl);
    await client.reverseTransaction({ phoneNumber: '3001234567', value: 152000.2, messageId: 'abc123def0' });

    const call = f.calls[1];
    assert.equal(call.url, 'https://api.sandbox.nequi.com/payments/v2/-services-reverseservices-reversetransaction');
    const body = JSON.parse(String(call.init!.body));
    assert.equal(body.RequestMessage.RequestHeader.Destination.ServiceName, 'ReverseServices');
    assert.equal(body.RequestMessage.RequestHeader.Destination.ServiceOperation, 'reverseTransaction');
    assert.deepEqual(body.RequestMessage.RequestBody.any, {
      reversionRQ: { phoneNumber: '3001234567', value: '152000', code: 'NIT_1', messageId: 'abc123def0', type: 'payment' },
    });
  });

  it('el cobro usa el MessageID que se le pasa (para poder reversarlo luego)', async () => {
    const f = fakeFetch([TOKEN(), ok({ unregisteredPaymentRS: { transactionId: 'tx' } })]);
    const client = new NequiClient(readNequiConfig(ENV), f.impl);
    const res = await client.sendPushPayment({ phoneNumber: '3001234567', value: 1000, messageId: 'fixed00001' });
    assert.equal(res.messageId, 'fixed00001');
    assert.equal(JSON.parse(String(f.calls[1].init!.body)).RequestMessage.RequestHeader.MessageID, 'fixed00001');
  });

  it('solo se reversa automáticamente cuando el resultado del envío es dudoso', () => {
    assert.equal(isAmbiguousSendFailure(new TypeError('fetch failed')), true); // red
    assert.equal(isAmbiguousSendFailure(Object.assign(new Error('t'), { name: 'TimeoutError' })), true);
    assert.equal(isAmbiguousSendFailure(new NequiApiError('HTTP 502', null, 502)), true);
    assert.equal(isAmbiguousSendFailure(new NequiApiError('sin transactionId', null, null)), true);
    assert.equal(isAmbiguousSendFailure(new NequiApiError('no tiene Nequi', '20-07A', 200)), false);
    assert.equal(isAmbiguousSendFailure(new NequiApiError('HTTP 400', null, 400)), false);
    assert.equal(isAmbiguousSendFailure(new NequiAuthError('token', null, 401)), false);
    assert.equal(isAmbiguousSendFailure(new NequiNotConfiguredError()), false);
  });

  it('un fallo del token es NequiAuthError (nada llegó a Nequi)', async () => {
    const f = fakeFetch([jsonResponse(401, {})]);
    const client = new NequiClient(readNequiConfig(ENV), f.impl);
    await assert.rejects(client.sendPushPayment({ phoneNumber: '3001234567', value: 1 }), NequiAuthError);
  });
});

describe('cobro de varios pedidos (carrito)', () => {
  it('recordOrderIds: la lista de la compra, o solo el pedido en registros de uno', () => {
    assert.deepEqual(recordOrderIds({ orderId: 'a', orderIds: ['a', 'b'] }), ['a', 'b']);
    assert.deepEqual(recordOrderIds({ orderId: 'a' }), ['a']);
    assert.deepEqual(recordOrderIds({ orderId: 'a', orderIds: [] }), ['a']);
  });

  it('nequiRecordKey: busca el cobro con el pedido principal de la compra', () => {
    assert.equal(nequiRecordKey('b', { checkoutGroup: { leadOrderId: 'a' } }), 'a');
    assert.equal(nequiRecordKey('b', {}), 'b');
    assert.equal(nequiRecordKey('b', null), 'b');
    // Un valor raro escrito por el cliente no sirve de ruta.
    assert.equal(nequiRecordKey('b', { checkoutGroup: { leadOrderId: 'x/y' } }), 'b');
    assert.equal(nequiRecordKey('b', { checkoutGroup: { leadOrderId: 42 } }), 'b');
  });
});
