import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { renderEmail } from './email-template';
import {
  DEFAULT_ORDER_EMAILS, ORDER_EMAIL_EVENTS, SAMPLE_CONTEXT, eventForStatus, fillOrderVariables, mergeTemplate, orderEmailContext,
} from './order-emails';

describe('correos de pedido: eventos', () => {
  it('solo los cuatro estados del pedido disparan correo (mock_paid y borradores no)', () => {
    assert.deepEqual(ORDER_EMAIL_EVENTS.map(eventForStatus), ['paid', 'en_produccion', 'enviado', 'entregado']);
    for (const s of ['mock_paid', 'pending', 'saved_draft', 'custom_pendiente', undefined, 42]) assert.equal(eventForStatus(s), null);
  });

  it('por defecto todos vienen apagados y con texto', () => {
    for (const e of ORDER_EMAIL_EVENTS) {
      assert.equal(DEFAULT_ORDER_EMAILS[e].enabled, false);
      assert.ok(DEFAULT_ORDER_EMAILS[e].subject.includes('{{pedido}}'));
    }
  });
});

describe('mergeTemplate', () => {
  it('sin documento guardado usa el texto por defecto, apagado', () => {
    assert.deepEqual(mergeTemplate('enviado', undefined), DEFAULT_ORDER_EMAILS.enviado);
  });

  it('respeta lo guardado y rellena lo vacío; solo enabled === true enciende', () => {
    const t = mergeTemplate('paid', { enabled: 'yes', subject: 'Gracias', body: '  ', format: 'html' });
    assert.equal(t.enabled, false);
    assert.equal(t.subject, 'Gracias');
    assert.equal(t.body, DEFAULT_ORDER_EMAILS.paid.body);
    assert.equal(t.format, 'html');
    assert.equal(mergeTemplate('paid', { enabled: true }).enabled, true);
  });
});

describe('orderEmailContext', () => {
  it('prefiere el correo y nombre de envío, luego los del pedido y luego el usuario', () => {
    const ctx = orderEmailContext('abcdefgh1234', {
      shippingAddress: { email: ' Ana@Mail.com ', name: 'Ana Pérez' },
      customerEmail: 'otra@mail.com',
      product: { name: 'Álbum 20x20' },
    }, { email: 'user@mail.com' }, 'https://jiffyphotos.com/');
    assert.deepEqual(ctx, { email: 'ana@mail.com', name: 'Ana Pérez', orderCode: '#ABCDEFGH', product: 'Álbum 20x20', link: 'https://jiffyphotos.com/dashboard' });
    assert.equal(orderEmailContext('x', {}, { email: 'u@m.co', name: 'U' }, 'https://a.co').email, 'u@m.co');
    assert.equal(orderEmailContext('x', {}, undefined, 'https://a.co').product, 'tu álbum');
  });

  it('una compra de varios productos se nombra por su número de productos', () => {
    const order = { product: { name: 'Álbum' }, checkoutGroup: { id: 'g', orderIds: ['x', 'y', 'z'] } };
    assert.equal(orderEmailContext('x', order, undefined, 'https://a.co').product, '3 productos');
    assert.equal(orderEmailContext('x', { ...order, checkoutGroup: { id: 'g', orderIds: ['x'] } }, undefined, 'https://a.co').product, 'Álbum');
  });
});

describe('fillOrderVariables + renderEmail', () => {
  it('texto: sustituye las variables; el pie es de pedido, sin enlace de baja', () => {
    const t = DEFAULT_ORDER_EMAILS.paid;
    const r = renderEmail({
      subject: fillOrderVariables(t.subject, SAMPLE_CONTEXT, 'subject'),
      body: fillOrderVariables(t.body, SAMPLE_CONTEXT, 'text'),
      format: 'text',
      recipientName: SAMPLE_CONTEXT.name,
    });
    assert.equal(r.subject, '¡Recibimos tu pedido #A1B2C3D4, María!');
    assert.match(r.text, /Álbum 20x20 tapa dura/);
    assert.match(r.text, /hiciste un pedido en Jiffy Photos/);
    assert.doesNotMatch(r.html, /date de baja/);
  });

  it('HTML: escapa los valores y el enlace queda clicable', () => {
    const ctx = { ...SAMPLE_CONTEXT, product: '<b>Álbum</b>' };
    const out = fillOrderVariables('<p>{{producto}} {{ enlace }}</p>', ctx, 'html');
    assert.equal(out, '<p>&lt;b&gt;Álbum&lt;/b&gt; <a href="https://jiffyphotos.com/dashboard">https://jiffyphotos.com/dashboard</a></p>');
  });
});
