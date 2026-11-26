import { EmailBodyFormat, escapeHtml } from './email-template';

/**
 * Correos automáticos de pedido: uno por cada paso del pedido.
 *
 * Son transaccionales (confirman algo que el cliente hizo), así que se envían
 * también a quien se dio de baja de las campañas, y llevan un pie distinto, sin
 * enlace de baja. El texto lo edita el dueño en `email_automations/{evento}`;
 * mientras no lo haga se usan los textos de aquí, apagados.
 */

export const ORDER_EMAIL_EVENTS = ['paid', 'en_produccion', 'enviado', 'entregado'] as const;
export type OrderEmailEvent = typeof ORDER_EMAIL_EVENTS[number];

export const AUTOMATIONS_COLLECTION = 'email_automations';
export const ORDER_EMAILS_LOG = 'order_emails';

export function isOrderEmailEvent(value: unknown): value is OrderEmailEvent {
  return typeof value === 'string' && (ORDER_EMAIL_EVENTS as readonly string[]).includes(value);
}

/** Estado del pedido → evento. `mock_paid` (pagos de prueba) no envía nada. */
export function eventForStatus(status: unknown): OrderEmailEvent | null {
  return isOrderEmailEvent(status) ? status : null;
}

export interface OrderEmailTemplate {
  enabled: boolean;
  subject: string;
  body: string;
  format: EmailBodyFormat;
}

export const DEFAULT_ORDER_EMAILS: Record<OrderEmailEvent, OrderEmailTemplate> = {
  paid: {
    enabled: false,
    subject: '¡Recibimos tu pedido {{pedido}}, {{nombre}}!',
    body: 'Hola {{nombre}},\n\n¡Gracias por tu compra! Confirmamos el pago de tu pedido {{pedido}} ({{producto}}).\n\nNuestro equipo va a revisar tu diseño y te avisaremos por correo cuando entre en producción.\n\nPuedes ver el estado de tu pedido en cualquier momento aquí: {{enlace}}\n\nCon cariño,\nEl equipo de Jiffy Photos',
    format: 'text',
  },
  en_produccion: {
    enabled: false,
    subject: 'Tu pedido {{pedido}} ya está en producción',
    body: 'Hola {{nombre}},\n\n¡Buenas noticias! Tu pedido {{pedido}} ({{producto}}) ya está en producción. Estamos imprimiendo y armando cada página con mucho cuidado.\n\nTe escribiremos de nuevo cuando salga hacia tu dirección.\n\nEstado de tu pedido: {{enlace}}\n\nEl equipo de Jiffy Photos',
    format: 'text',
  },
  enviado: {
    enabled: false,
    subject: 'Tu pedido {{pedido}} va en camino',
    body: 'Hola {{nombre}},\n\nTu pedido {{pedido}} ({{producto}}) ya salió y va en camino a tu dirección.\n\nSi tienes alguna pregunta sobre la entrega, responde a este correo.\n\nEstado de tu pedido: {{enlace}}\n\nEl equipo de Jiffy Photos',
    format: 'text',
  },
  entregado: {
    enabled: false,
    subject: 'Tu pedido {{pedido}} fue entregado',
    body: 'Hola {{nombre}},\n\nTu pedido {{pedido}} ({{producto}}) ya fue entregado. ¡Esperamos que lo disfrutes muchísimo!\n\nNos encantaría saber qué te pareció: responde a este correo y cuéntanos.\n\nEl equipo de Jiffy Photos',
    format: 'text',
  },
};

/** Plantilla guardada encima de la de por defecto; lo que falte o no valga se rellena. */
export function mergeTemplate(event: OrderEmailEvent, stored: Record<string, any> | undefined): OrderEmailTemplate {
  const base = DEFAULT_ORDER_EMAILS[event];
  if (!stored) return { ...base };
  const subject = typeof stored.subject === 'string' && stored.subject.trim() ? stored.subject : base.subject;
  const body = typeof stored.body === 'string' && stored.body.trim() ? stored.body : base.body;
  return {
    enabled: stored.enabled === true,
    subject,
    body,
    format: stored.format === 'html' ? 'html' : stored.format === 'text' ? 'text' : base.format,
  };
}

export interface OrderEmailContext {
  email: string;
  name: string;
  orderCode: string;
  product: string;
  link: string;
}

/** Datos del correo a partir del documento del pedido (y del usuario, si hace falta). */
export function orderEmailContext(
  orderId: string,
  order: Record<string, any>,
  user: Record<string, any> | undefined,
  publicSiteUrl: string,
): OrderEmailContext {
  const email = String(order.shippingAddress?.email || order.customerEmail || user?.email || '').trim().toLowerCase();
  const name = String(order.shippingAddress?.name || order.customerName || user?.name || '').trim();
  // Compra de varios productos (carrito): el correo es de la compra entera.
  const groupSize = Array.isArray(order.checkoutGroup?.orderIds) ? order.checkoutGroup.orderIds.length : 0;
  const product = groupSize > 1
    ? `${groupSize} productos`
    : String(order.product?.name || order.productName || order.productType || 'tu álbum').trim();
  return {
    email,
    name,
    orderCode: `#${orderId.slice(0, 8).toUpperCase()}`,
    product,
    link: `${publicSiteUrl.replace(/\/+$/, '')}/dashboard`,
  };
}

export const SAMPLE_CONTEXT: OrderEmailContext = {
  email: 'cliente@ejemplo.com',
  name: 'María Fernanda',
  orderCode: '#A1B2C3D4',
  product: 'Álbum 20x20 tapa dura',
  link: 'https://jiffyphotos.com/dashboard',
};

const VARS: Array<[RegExp, keyof OrderEmailContext]> = [
  [/\{\{\s*pedido\s*\}\}/gi, 'orderCode'],
  [/\{\{\s*producto\s*\}\}/gi, 'product'],
  [/\{\{\s*enlace\s*\}\}/gi, 'link'],
];

/**
 * Sustituye `{{pedido}}`, `{{producto}}` y `{{enlace}}` (`{{nombre}}` lo hace
 * renderEmail). En HTML los valores se escapan y el enlace se vuelve clicable.
 */
export function fillOrderVariables(text: string, ctx: OrderEmailContext, format: EmailBodyFormat | 'subject'): string {
  let out = text;
  for (const [re, key] of VARS) {
    const value = ctx[key];
    out = out.replace(re, () => {
      if (format !== 'html') return value;
      if (key === 'link') return `<a href="${escapeHtml(value)}">${escapeHtml(value)}</a>`;
      return escapeHtml(value);
    });
  }
  return out;
}
