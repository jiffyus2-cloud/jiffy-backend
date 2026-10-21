import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase-admin';
import { EmailConfig, missingEmailConfig, readEmailConfig } from './email.config';
import { EmailProvider, OutgoingEmail, SendResult, createEmailProvider, sleep } from './email-provider';
import { EmailBodyFormat, renderEmail } from './email-template';
import { Audience, EmailSegment, PURCHASED_STATUSES, UserDoc, isEmailSegment, isValidEmail, orderOwnerUid, resolveAudience } from './recipients';
import { createUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribe-token';

/**
 * Correos masivos a los usuarios registrados (pestaña "Correos" del panel).
 *
 * - Destinatarios: colección `users`, menos quien tenga `emailOptOut: true`.
 * - Cada correo lleva su enlace de baja firmado y las cabeceras
 *   `List-Unsubscribe` / `List-Unsubscribe-Post` (baja en un clic de Gmail/Yahoo).
 * - Cada campaña queda en `email_campaigns/{id}`. El id lo genera el panel, así
 *   que pulsar dos veces "Enviar" no manda la campaña dos veces.
 *
 * El envío es síncrono: la petición vuelve cuando se ha intentado el último
 * lote. Con 100 correos por lote y 600 ms de pausa son ~170 correos/s, de sobra
 * para el volumen actual y muy por debajo del timeout de Cloud Run (300 s).
 */

export const CAMPAIGNS_COLLECTION = 'email_campaigns';
const MAX_SUBJECT = 200;
const MAX_BODY = 100_000;
const MAX_STORED_FAILURES = 50;

export interface CampaignDraft {
  subject: string;
  body: string;
  format: EmailBodyFormat;
}

export interface CampaignRecord {
  id: string;
  subject: string;
  body: string;
  format: EmailBodyFormat;
  segment: EmailSegment;
  status: 'sending' | 'sent' | 'partial' | 'failed';
  recipients: number;
  sent: number;
  failed: number;
  skippedOptOut: number;
  skippedInvalid: number;
  provider: string;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
  failures: Array<{ email: string; error: string }>;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  status() {
    const config = readEmailConfig();
    return {
      provider: config.provider,
      from: config.from || null,
      replyTo: config.replyTo || null,
      postalAddress: config.postalAddress || null,
      missing: missingEmailConfig(config),
      ready: missingEmailConfig(config).length === 0,
    };
  }

  async audience(segment: unknown): Promise<Omit<Audience, 'recipients'> & { recipients: number }> {
    const resolved = await this.resolve(this.parseSegment(segment));
    return { ...resolved, recipients: resolved.recipients.length };
  }

  preview(draft: unknown, baseUrl: string) {
    const parsed = this.parseDraft(draft);
    const config = readEmailConfig();
    return renderEmail({
      ...parsed,
      recipientName: 'María Fernanda',
      unsubscribeUrl: `${this.unsubscribeBase(config, baseUrl)}?token=vista-previa`,
      postalAddress: config.postalAddress,
    });
  }

  /** Envía la campaña a un solo correo, con "[PRUEBA]" en el asunto. No deja historial. */
  async sendTest(input: unknown, baseUrl: string): Promise<SendResult> {
    const draft = this.parseDraft(input);
    const to = String((input as any)?.to || '').trim().toLowerCase();
    if (!isValidEmail(to)) throw new BadRequestException('Escribe un correo válido para la prueba.');

    const config = this.requireConfig();
    const provider = createEmailProvider(config);

    // Si el correo es de un usuario registrado, el enlace de baja es el suyo de
    // verdad; si no, uno de muestra que no da de baja a nadie.
    const match = await getFirestore().collection('users').where('email', '==', to).limit(1).get();
    const user = match.docs[0];
    const token = user ? createUnsubscribeToken(user.id, config.unsubscribeSecret) : 'prueba';
    const message = this.buildMessage(draft, { email: to, name: user?.get('name') || '' }, token, config, baseUrl, 'test');
    message.subject = `[PRUEBA] ${message.subject}`;

    const [result] = await provider.sendBatch([message]);
    if (!result.ok) this.logger.warn(`Envío de prueba fallido: ${result.error}`);
    return result;
  }

  async sendCampaign(input: unknown, createdBy: string, baseUrl: string): Promise<CampaignRecord> {
    const draft = this.parseDraft(input);
    const segment = this.parseSegment((input as any)?.segment);
    const campaignId = String((input as any)?.campaignId || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(campaignId)) throw new BadRequestException('Falta un campaignId válido.');

    const config = this.requireConfig();
    const provider = createEmailProvider(config);
    const audience = await this.resolve(segment);
    if (audience.recipients.length === 0) throw new BadRequestException('Ese segmento no tiene destinatarios.');

    const ref = getFirestore().collection(CAMPAIGNS_COLLECTION).doc(campaignId);
    const record: CampaignRecord = {
      id: campaignId,
      ...draft,
      segment,
      status: 'sending',
      recipients: audience.recipients.length,
      sent: 0,
      failed: 0,
      skippedOptOut: audience.optedOut,
      skippedInvalid: audience.invalidEmail,
      provider: provider.name,
      createdBy,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      failures: [],
    };

    // `create` falla si el documento existe: es la guarda contra el doble envío.
    try {
      await ref.create(record);
    } catch (error: any) {
      if (error?.code === 6 /* ALREADY_EXISTS */) {
        throw new ConflictException('Esta campaña ya se envió (o se está enviando). Revisa el historial.');
      }
      throw error;
    }

    const messages = audience.recipients.map(r =>
      this.buildMessage(draft, r, createUnsubscribeToken(r.uid, config.unsubscribeSecret), config, baseUrl, campaignId),
    );

    for (let i = 0; i < messages.length; i += provider.maxBatchSize) {
      if (i > 0) await sleep(provider.pauseBetweenBatchesMs);
      const batch = messages.slice(i, i + provider.maxBatchSize);
      const results = await provider.sendBatch(batch, `${campaignId}-${i / provider.maxBatchSize}`);
      for (const result of results) {
        if (result.ok) {
          record.sent++;
        } else {
          record.failed++;
          if (record.failures.length < MAX_STORED_FAILURES) {
            record.failures.push({ email: result.to, error: String(result.error || 'Error desconocido').slice(0, 300) });
          }
        }
      }
      // Progreso intermedio: si el proceso muere a mitad, el historial lo refleja.
      await ref.update({ sent: record.sent, failed: record.failed, failures: record.failures });
    }

    record.status = record.failed === 0 ? 'sent' : record.sent === 0 ? 'failed' : 'partial';
    record.finishedAt = new Date().toISOString();
    await ref.update({ status: record.status, finishedAt: record.finishedAt });
    this.logger.log(`Campaña ${campaignId}: ${record.sent} enviados, ${record.failed} fallidos (${segment}).`);
    return record;
  }

  async listCampaigns(limit = 50): Promise<CampaignRecord[]> {
    const snap = await getFirestore()
      .collection(CAMPAIGNS_COLLECTION)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(Math.max(limit, 1), 200))
      .get();
    return snap.docs.map(d => d.data() as CampaignRecord);
  }

  /**
   * Marca la baja. Devuelve false si el token no es válido. Idempotente: darse
   * de baja dos veces no es un error.
   */
  async unsubscribe(token: string, source: 'link' | 'one-click'): Promise<boolean> {
    const uid = verifyUnsubscribeToken(token, readEmailConfig().unsubscribeSecret);
    if (!uid) return false;
    try {
      await getFirestore().collection('users').doc(uid).update({
        emailOptOut: true,
        emailOptOutAt: admin.firestore.FieldValue.serverTimestamp(),
        emailOptOutSource: source,
      });
    } catch (error: any) {
      // Usuario borrado: ya no recibirá nada, así que la baja es efectiva igual.
      if (error?.code !== 5 /* NOT_FOUND */) throw error;
    }
    this.logger.log(`Baja de correos registrada (${source}).`);
    return true;
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private async resolve(segment: EmailSegment): Promise<Audience> {
    const db = getFirestore();
    const usersSnap = await db.collection('users').select('name', 'email', 'emailOptOut').get();
    const users: UserDoc[] = usersSnap.docs.map(d => ({ uid: d.id, ...(d.data() as Omit<UserDoc, 'uid'>) }));

    const buyers = new Set<string>();
    if (segment !== 'all') {
      // `collectionGroup('orders')` cubre `orders/{id}` y los antiguos `users/{uid}/orders/{id}`.
      const ordersSnap = await db.collectionGroup('orders').select('userId', 'status').get();
      for (const order of ordersSnap.docs) {
        if (!PURCHASED_STATUSES.has(String(order.get('status') || ''))) continue;
        const uid = orderOwnerUid(order.ref.path, { userId: order.get('userId') });
        if (uid) buyers.add(uid);
      }
    }
    return resolveAudience(users, buyers, segment);
  }

  private buildMessage(
    draft: CampaignDraft,
    recipient: { email: string; name: string },
    token: string,
    config: EmailConfig,
    baseUrl: string,
    campaignTag: string,
  ): OutgoingEmail {
    const unsubscribeUrl = `${this.unsubscribeBase(config, baseUrl)}?token=${encodeURIComponent(token)}`;
    const rendered = renderEmail({
      ...draft,
      recipientName: recipient.name,
      unsubscribeUrl,
      postalAddress: config.postalAddress,
    });
    return {
      to: recipient.email,
      ...rendered,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tags: { campaign: campaignTag.replace(/[^A-Za-z0-9_-]/g, '_') },
    };
  }

  private unsubscribeBase(config: EmailConfig, requestBaseUrl: string): string {
    return `${config.publicBaseUrl || requestBaseUrl}/email/unsubscribe`;
  }

  private requireConfig(): EmailConfig {
    const config = readEmailConfig();
    const missing = missingEmailConfig(config);
    if (missing.length) {
      throw new ServiceUnavailableException(`El envío de correos no está configurado. Falta: ${missing.join(', ')}.`);
    }
    return config;
  }

  private parseSegment(value: unknown): EmailSegment {
    if (!isEmailSegment(value)) throw new BadRequestException('Segmento no válido (all, with_orders, without_orders).');
    return value;
  }

  private parseDraft(input: unknown): CampaignDraft {
    const subject = String((input as any)?.subject || '').trim();
    const body = String((input as any)?.body || '');
    const format = (input as any)?.format === 'html' ? 'html' : 'text';
    if (!subject) throw new BadRequestException('Escribe un asunto.');
    if (subject.length > MAX_SUBJECT) throw new BadRequestException(`El asunto no puede pasar de ${MAX_SUBJECT} caracteres.`);
    if (!body.trim()) throw new BadRequestException('Escribe el contenido del correo.');
    if (body.length > MAX_BODY) throw new BadRequestException('El contenido es demasiado largo.');
    return { subject, body, format };
  }
}
