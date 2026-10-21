import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribe-token';
import { htmlToText, renderEmail } from './email-template';
import { orderOwnerUid, resolveAudience } from './recipients';
import { ResendProvider } from './email-provider';
import { missingEmailConfig, readEmailConfig } from './email.config';

// Se ejecutan sobre el JS compilado (ver el script `test` de package.json).

describe('token de baja', () => {
  it('ida y vuelta con el mismo secreto', () => {
    const token = createUnsubscribeToken('abc123', 's3cret');
    assert.equal(verifyUnsubscribeToken(token, 's3cret'), 'abc123');
  });

  it('rechaza otro secreto, firmas alteradas y basura', () => {
    const token = createUnsubscribeToken('abc123', 's3cret');
    assert.equal(verifyUnsubscribeToken(token, 'otro'), null);
    const [v, uid] = token.split('.');
    const forged = `${v}.${Buffer.from('otro-uid').toString('base64url')}.${token.split('.')[2]}`;
    assert.equal(verifyUnsubscribeToken(forged, 's3cret'), null);
    assert.equal(verifyUnsubscribeToken(`${v}.${uid}.xx`, 's3cret'), null);
    assert.equal(verifyUnsubscribeToken('prueba', 's3cret'), null);
    assert.equal(verifyUnsubscribeToken(token, ''), null);
  });

  it('sin secreto no se puede firmar', () => {
    assert.throws(() => createUnsubscribeToken('abc', ''));
  });
});

describe('renderEmail', () => {
  const base = { unsubscribeUrl: 'https://api.test/email/unsubscribe?token=t', recipientName: 'Ana <b>María</b> Pérez' };

  it('texto plano: escapa, sustituye {{nombre}} y añade el pie de baja', () => {
    const r = renderEmail({ ...base, subject: 'Hola {{nombre}}', body: 'Hola {{ nombre }}\n\n<script>x</script>', format: 'text' });
    assert.equal(r.subject, 'Hola Ana');
    assert.match(r.html, /Hola Ana/);
    assert.match(r.html, /&lt;script&gt;/);
    assert.match(r.html, /href="https:\/\/api\.test\/email\/unsubscribe\?token=t"/);
    assert.match(r.text, /Para darte de baja: https:\/\/api\.test\/email\/unsubscribe\?token=t/);
  });

  it('HTML: el nombre del destinatario se escapa aunque el cuerpo sea HTML', () => {
    const r = renderEmail({ ...base, recipientName: '<img>', subject: 'x', body: '<p>Hola {{nombre}}</p>', format: 'html' });
    assert.match(r.html, /<p>Hola &lt;img&gt;<\/p>/);
  });

  it('sin nombre no deja huecos raros en el asunto', () => {
    const r = renderEmail({ ...base, recipientName: '', subject: 'Hola {{nombre}}, novedades', body: 'x', format: 'text' });
    assert.equal(r.subject, 'Hola, novedades');
  });

  it('incluye la dirección postal si está configurada', () => {
    const r = renderEmail({ ...base, subject: 's', body: 'b', format: 'text', postalAddress: 'Calle 1 # 2-3, Bogotá' });
    assert.match(r.html, /Calle 1 # 2-3, Bogotá/);
    assert.match(r.text, /Calle 1 # 2-3, Bogotá/);
  });

  it('htmlToText conserva enlaces y saltos', () => {
    assert.equal(htmlToText('<p>Uno</p><p>Mira <a href="https://x.co">esto</a></p>'), 'Uno\nMira esto (https://x.co)');
  });
});

describe('resolveAudience', () => {
  const users = [
    { uid: 'a', name: 'A', email: 'A@x.co' },
    { uid: 'b', name: 'B', email: 'b@x.co', emailOptOut: true },
    { uid: 'c', name: 'C', email: 'no-es-correo' },
    { uid: 'd', name: 'D', email: 'a@x.co' },
    { uid: 'e', name: 'E', email: 'e@x.co' },
  ];
  const buyers = new Set(['a', 'b']);

  it('todos: excluye bajas, correos inválidos y duplicados', () => {
    const r = resolveAudience(users, buyers, 'all');
    assert.deepEqual(r.recipients.map(x => x.uid), ['a', 'e']);
    assert.equal(r.recipients[0].email, 'a@x.co');
    assert.deepEqual([r.inSegment, r.optedOut, r.invalidEmail, r.duplicates], [5, 1, 1, 1]);
  });

  it('con y sin pedidos', () => {
    assert.deepEqual(resolveAudience(users, buyers, 'with_orders').recipients.map(x => x.uid), ['a']);
    assert.deepEqual(resolveAudience(users, buyers, 'without_orders').recipients.map(x => x.uid), ['d', 'e']);
  });

  it('el comprador sale de userId o de la ruta antigua', () => {
    assert.equal(orderOwnerUid('orders/o1', { userId: 'u1' }), 'u1');
    assert.equal(orderOwnerUid('users/u2/orders/o2', {}), 'u2');
    assert.equal(orderOwnerUid('orders/o3', {}), null);
  });
});

describe('configuración', () => {
  it('lista solo los nombres de lo que falta', () => {
    assert.deepEqual(missingEmailConfig(readEmailConfig({})), ['EMAIL_PROVIDER_API_KEY', 'EMAIL_FROM', 'EMAIL_UNSUBSCRIBE_SECRET']);
    assert.deepEqual(missingEmailConfig(readEmailConfig({ EMAIL_PROVIDER_API_KEY: 'k', EMAIL_FROM: 'a@b.co', EMAIL_UNSUBSCRIBE_SECRET: 's' })), []);
  });
});

describe('ResendProvider', () => {
  const config = { apiKey: 're_test', from: 'Jiffy <hola@x.co>', replyTo: '' };
  const msg = (to: string) => ({ to, subject: 's', html: '<p>h</p>', text: 't', headers: { 'List-Unsubscribe': '<u>' }, tags: { campaign: 'c1' } });
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  });

  it('manda el lote con Bearer, Idempotency-Key y un correo por destinatario', async () => {
    const calls: any[] = [];
    const provider = new ResendProvider(config, async (url, init) => {
      calls.push({ url, init });
      return response(200, { data: [{ id: '1' }, { id: '2' }] });
    });
    const results = await provider.sendBatch([msg('a@x.co'), msg('b@x.co')], 'camp-0');
    assert.deepEqual(results.map(r => [r.to, r.ok, r.id]), [['a@x.co', true, '1'], ['b@x.co', true, '2']]);
    assert.equal(calls[0].url, 'https://api.resend.com/emails/batch');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test');
    assert.equal(calls[0].init.headers['Idempotency-Key'], 'camp-0');
    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(sent[0].to, ['a@x.co']);
    assert.deepEqual(sent[0].tags, [{ name: 'campaign', value: 'c1' }]);
  });

  it('un 429 se reintenta una vez; un error se marca en todo el lote', async () => {
    let n = 0;
    const provider = new ResendProvider(config, async () => (++n === 1 ? response(429, {}, { 'retry-after': '0' }) : response(422, { message: 'from no verificado' })));
    const results = await provider.sendBatch([msg('a@x.co')]);
    assert.equal(n, 2);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error!, /422.*from no verificado/);
  });

  it('un fallo de red no lanza', async () => {
    const provider = new ResendProvider(config, async () => { throw new Error('ECONNRESET'); });
    const [r] = await provider.sendBatch([msg('a@x.co')]);
    assert.equal(r.ok, false);
    assert.match(r.error!, /ECONNRESET/);
  });
});
