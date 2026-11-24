import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { getFirestore } from '../firebase/firebase-admin';
import { missingEmailConfig, readEmailConfig } from './email.config';
import { SendResult, createEmailProvider } from './email-provider';
import { RenderedEmail, renderEmail } from './email-template';
import {
  AUTOMATIONS_COLLECTION, OrderEmailContext, OrderEmailEvent, OrderEmailTemplate, ORDER_EMAILS_LOG, ORDER_EMAIL_EVENTS, SAMPLE_CONTEXT,
  eventForStatus, fillOrderVariables, isOrderEmailEvent, mergeTemplate, orderEmailContext,
} from './order-emails';
import { isValidEmail } from './recipients';

export type NotifyOutcome =
  | { status: 'sent'; event: OrderEmailEvent; to: string }
  | { status: 'failed'; event: OrderEmailEvent; to: string; error: string }
  | { status: 'skipped'; event: OrderEmailEvent | null; reason: 'not_configured' | 'no_event' | 'disabled' | 'already_sent' | 'no_email' | 'order_not_found' };

export interface OrderEmailLogEntry {
  id: string;
  orderId: string;
  event: OrderEmailEvent;
  to: string;
  subject: string;
  state: 'sending' | 'sent' | 'failed';
  error: string | null;
  providerId: string | null;
  createdAt: string;
  updatedAt: string;
}

const MAX_SUBJECT = 200;
const MAX_BODY = 100_000;
const ALREADY_EXISTS = 6; // código gRPC de Firestore

/**
 * Envía los correos automáticos de pedido (ver order-emails.ts).
 *
 * Cada (pedido, evento) se envía una sola vez: antes de enviar se crea
 * `order_emails/{orderId}_{evento}`, y si ya existe no se repite (Stripe
 * reintenta sus webhooks y el dueño puede mover un pedido atrás y adelante).
 * Si el envío falló, el siguiente aviso del mismo evento lo reintenta.
 *
 * Nunca lanza desde notify(): un correo que no sale no debe tumbar un pago.
 */
@Injectable()
export class OrderEmailService {
  private readonly logger = new Logger(OrderEmailService.name);

  async notify(orderId: string, onlyEvent?: OrderEmailEvent): Promise<NotifyOutcome> {
    try {
      return await this.notifyUnsafe(orderId, onlyEvent);
    } catch (err: any) {
      this.logger.error(`Correo automático del pedido ${orderId} falló: ${err?.message || err}`);
      return { status: 'failed', event: onlyEvent ?? null as any, to: '', error: String(err?.message || err) };
    }
  }

  private async notifyUnsafe(orderId: string, onlyEvent?: OrderEmailEvent): Promise<NotifyOutcome> {
    const config = readEmailConfig();
    if (missingEmailConfig(config).length) return { status: 'skipped', event: onlyEvent ?? null, reason: 'not_configured' };

    const db = getFirestore();
    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) return { status: 'skipped', event: onlyEvent ?? null, reason: 'order_not_found' };
    const order = orderSnap.data() as Record<string, any>;

    const event = eventForStatus(order.status);
    if (!event || (onlyEvent && event !== onlyEvent)) return { status: 'skipped', event: onlyEvent ?? event, reason: 'no_event' };

    const template = await this.loadTemplate(event);
    if (!template.enabled) return { status: 'skipped', event, reason: 'disabled' };

    let user: Record<string, any> | undefined;
    if (!order.shippingAddress?.email && !order.customerEmail && order.userId) {
      user = (await db.collection('users').doc(String(order.userId)).get()).data();
    }
    const ctx = orderEmailContext(orderId, order, user, this.siteUrl());
    if (!isValidEmail(ctx.email)) return { status: 'skipped', event, reason: 'no_email' };

    const rendered = this.render(template, ctx, config.postalAddress);
    const logRef = db.collection(ORDER_EMAILS_LOG).doc(`${orderId}_${event}`);
    const now = new Date().toISOString();
    const entry = { orderId, event, to: ctx.email, subject: rendered.subject, state: 'sending', error: null, providerId: null, createdAt: now, updatedAt: now };
    try {
      await logRef.create(entry);
    } catch (err: any) {
      if (err?.code !== ALREADY_EXISTS) throw err;
      // Solo se reintenta lo que falló; lo enviado (o enviándose) no se repite.
      const retried = await db.runTransaction(async tx => {
        const snap = await tx.get(logRef);
        if ((snap.data() as any)?.state !== 'failed') return false;
        tx.update(logRef, { ...entry, createdAt: (snap.data() as any)?.createdAt || now });
        return true;
      });
      if (!retried) return { status: 'skipped', event, reason: 'already_sent' };
    }

    const result = await this.send(ctx.email, rendered, event);
    await logRef.update({
      state: result.ok ? 'sent' : 'failed',
      error: result.ok ? null : String(result.error || 'error desconocido').slice(0, 500),
      providerId: result.id || null,
      updatedAt: new Date().toISOString(),
    });
    if (result.ok) {
      this.logger.log(`Correo «${event}» del pedido ${orderId} enviado.`);
      return { status: 'sent', event, to: ctx.email };
    }
    this.logger.warn(`Correo «${event}» del pedido ${orderId} falló: ${result.error}`);
    return { status: 'failed', event, to: ctx.email, error: String(result.error || '') };
  }

  /** Vista previa con un pedido de ejemplo. */
  preview(input: unknown): RenderedEmail {
    const { template } = this.parseInput(input);
    return this.render(template, SAMPLE_CONTEXT, readEmailConfig().postalAddress);
  }

  /** Envía la plantilla, con datos de ejemplo y "[PRUEBA]", a un solo correo. No deja registro. */
  async sendTest(input: unknown): Promise<SendResult> {
    const { template, event } = this.parseInput(input);
    const to = String((input as any)?.to || '').trim().toLowerCase();
    if (!isValidEmail(to)) throw new BadRequestException('Escribe un correo válido para la prueba.');
    const config = readEmailConfig();
    const missing = missingEmailConfig(config);
    if (missing.length) throw new ServiceUnavailableException(`El envío de correos no está configurado. Falta: ${missing.join(', ')}.`);
    const rendered = this.render(template, { ...SAMPLE_CONTEXT, email: to }, config.postalAddress);
    rendered.subject = `[PRUEBA] ${rendered.subject}`;
    return this.send(to, rendered, event);
  }

  /** Las cuatro plantillas tal como se usarían ahora (lo guardado sobre lo de por defecto). */
  async listTemplates(): Promise<Record<OrderEmailEvent, OrderEmailTemplate & { customized: boolean }>> {
    const snap = await getFirestore().collection(AUTOMATIONS_COLLECTION).get();
    const stored = new Map(snap.docs.map(d => [d.id, d.data()]));
    return Object.fromEntries(ORDER_EMAIL_EVENTS.map(e => [e, { ...mergeTemplate(e, stored.get(e)), customized: stored.has(e) }])) as any;
  }

  async listLog(limit = 50): Promise<OrderEmailLogEntry[]> {
    const snap = await getFirestore().collection(ORDER_EMAILS_LOG)
      .orderBy('createdAt', 'desc').limit(Math.min(Math.max(limit, 1), 200)).get();
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
  }

  private async loadTemplate(event: OrderEmailEvent): Promise<OrderEmailTemplate> {
    const snap = await getFirestore().collection(AUTOMATIONS_COLLECTION).doc(event).get();
    return mergeTemplate(event, snap.exists ? snap.data() : undefined);
  }

  private render(template: OrderEmailTemplate, ctx: OrderEmailContext, postalAddress: string): RenderedEmail {
    return renderEmail({
      subject: fillOrderVariables(template.subject, ctx, 'subject'),
      body: fillOrderVariables(template.body, ctx, template.format),
      format: template.format,
      recipientName: ctx.name,
      postalAddress,
    });
  }

  private async send(to: string, rendered: RenderedEmail, event: OrderEmailEvent): Promise<SendResult> {
    const provider = createEmailProvider(readEmailConfig());
    const [result] = await provider.sendBatch([{ to, ...rendered, tags: { order_email: event } }]);
    return result;
  }

  private siteUrl(): string {
    return (process.env.FRONTEND_URL || 'https://jiffyphotos.com').split(',')[0].trim();
  }

  private parseInput(input: unknown): { event: OrderEmailEvent; template: OrderEmailTemplate } {
    const event = (input as any)?.event;
    if (!isOrderEmailEvent(event)) throw new BadRequestException('Evento no válido (paid, en_produccion, enviado, entregado).');
    const subject = String((input as any)?.subject || '').trim();
    const body = String((input as any)?.body || '');
    if (!subject) throw new BadRequestException('Escribe un asunto.');
    if (subject.length > MAX_SUBJECT) throw new BadRequestException(`El asunto no puede pasar de ${MAX_SUBJECT} caracteres.`);
    if (!body.trim()) throw new BadRequestException('Escribe el contenido del correo.');
    if (body.length > MAX_BODY) throw new BadRequestException('El contenido es demasiado largo.');
    return { event, template: { enabled: true, subject, body, format: (input as any)?.format === 'html' ? 'html' : 'text' } };
  }
}
