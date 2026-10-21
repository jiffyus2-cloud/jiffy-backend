import { EmailConfig } from './email.config';

/**
 * Interfaz mínima del proveedor transaccional. El resto del módulo solo habla
 * con esto: cambiar Resend por otro (SES, Postmark, Brevo…) es escribir otra
 * implementación y registrarla en `createEmailProvider`.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Etiquetas para filtrar en el panel del proveedor (solo [A-Za-z0-9_-]). */
  tags?: Record<string, string>;
}

export interface SendResult {
  to: string;
  ok: boolean;
  id?: string;
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  /** Máximo de mensajes por llamada a `sendBatch`. */
  readonly maxBatchSize: number;
  /** Pausa entre lotes para respetar el límite de peticiones del proveedor. */
  readonly pauseBetweenBatchesMs: number;
  /**
   * Envía un lote (≤ maxBatchSize). Nunca lanza: devuelve un resultado por
   * mensaje, en el mismo orden. `idempotencyKey` evita duplicados si el mismo
   * lote se reintenta.
   */
  sendBatch(messages: OutgoingEmail[], idempotencyKey?: string): Promise<SendResult[]>;
}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/**
 * Resend (https://resend.com/docs/api-reference/emails/send-batch-emails).
 * `POST /emails/batch` admite hasta 100 correos distintos por llamada; el
 * límite por defecto es de 2 peticiones/s, de ahí la pausa de 600 ms.
 */
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  readonly maxBatchSize = 100;
  readonly pauseBetweenBatchesMs = 600;

  constructor(
    private readonly config: Pick<EmailConfig, 'apiKey' | 'from' | 'replyTo'>,
    private readonly fetchImpl: FetchLike = (globalThis as any).fetch,
    private readonly baseUrl = 'https://api.resend.com',
  ) {}

  async sendBatch(messages: OutgoingEmail[], idempotencyKey?: string): Promise<SendResult[]> {
    if (messages.length === 0) return [];
    if (messages.length > this.maxBatchSize) {
      throw new Error(`Resend admite como máximo ${this.maxBatchSize} correos por lote`);
    }

    const payload = messages.map(message => ({
      from: this.config.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(this.config.replyTo ? { reply_to: this.config.replyTo } : {}),
      ...(message.headers ? { headers: message.headers } : {}),
      ...(message.tags ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) } : {}),
    }));

    const failAll = (error: string): SendResult[] => messages.map(m => ({ to: m.to, ok: false, error }));

    // Un único reintento si Resend pide esperar (429); el resto de errores se
    // dan por fallidos y quedan en el historial de la campaña.
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/emails/batch`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body: JSON.stringify(payload),
        });
      } catch (error: any) {
        return failAll(`Sin conexión con Resend: ${error?.message ?? error}`);
      }

      const raw = await response.text();
      let data: any = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }

      if (response.status === 429 && attempt === 0) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000);
        continue;
      }

      if (!response.ok) {
        return failAll(`Resend HTTP ${response.status}: ${data?.message || raw.slice(0, 200) || 'sin detalle'}`);
      }

      const ids: Array<{ id?: string }> = Array.isArray(data?.data) ? data.data : [];
      return messages.map((m, i) => ({ to: m.to, ok: true, id: ids[i]?.id }));
    }
    return failAll('Resend siguió limitando las peticiones (429)');
  }
}

export function createEmailProvider(config: EmailConfig): EmailProvider {
  switch (config.provider) {
    case 'resend':
      return new ResendProvider(config);
    default:
      throw new Error(`Proveedor de correo desconocido: "${config.provider}" (implementados: resend)`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
