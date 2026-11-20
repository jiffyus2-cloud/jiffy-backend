import { randomUUID } from 'node:crypto';
import { NequiConfig, isNequiConfigured } from './nequi.config';

/**
 * Cliente mínimo de la API Nequi Conecta para pagos push ("pago sin registro").
 *
 * Flujo: pedimos un token OAuth (client_credentials), enviamos
 * `unregisteredPayment` con el celular del cliente → Nequi le manda una
 * notificación push → el cliente la acepta o la rechaza en su app → nosotros
 * preguntamos con `getStatusPayment` hasta que deja de estar pendiente. Nequi
 * no avisa por webhook en este producto: hay que consultar.
 *
 * Todas las peticiones van envueltas en el sobre `RequestMessage` de Nequi y
 * todas las respuestas traen `ResponseHeader.Status.StatusCode`, que es "0"
 * cuando la operación se aceptó. Cualquier otro código es un error de negocio
 * (celular sin Nequi, monto inválido…) con su descripción en `StatusDesc`.
 *
 * `fetch` y el reloj se inyectan para poder probarlo sin red.
 */

export const NEQUI_ENDPOINTS = {
  unregisteredPayment: '/payments/v2/-services-paymentservice-unregisteredpayment',
  getStatusPayment: '/payments/v2/-services-paymentservice-getstatuspayment',
  cancelUnregisteredPayment: '/payments/v2/-services-paymentservice-cancelunregisteredpayment',
} as const;

/** Canal de pagos push en Nequi Conecta. */
export const NEQUI_PUSH_CHANNEL = 'PNP04-C001';

/** Valores de `getStatusPaymentRS.status`. */
export const NEQUI_PAYMENT_STATUS = {
  PENDING: '33',
  COMPLETED: '35',
  FAILED: '71',
  EXPIRED: '10-454',
  CANCELLED_OR_REJECTED: '10-455',
} as const;

/** Estado de un cobro Nequi tal como lo guardamos en el pedido. */
export type NequiPaymentState = 'pending' | 'paid' | 'rejected' | 'expired' | 'failed' | 'cancelled';

export function mapNequiStatus(status: string | undefined | null): NequiPaymentState {
  switch (String(status ?? '').trim()) {
    case NEQUI_PAYMENT_STATUS.COMPLETED: return 'paid';
    case NEQUI_PAYMENT_STATUS.PENDING: return 'pending';
    case NEQUI_PAYMENT_STATUS.EXPIRED: return 'expired';
    case NEQUI_PAYMENT_STATUS.CANCELLED_OR_REJECTED: return 'rejected';
    case NEQUI_PAYMENT_STATUS.FAILED: return 'failed';
    // Un código que no conocemos NO puede marcar el pedido como pagado ni
    // cerrarlo: lo tratamos como pendiente y se vuelve a consultar.
    default: return 'pending';
  }
}

/**
 * Celular colombiano de 10 dígitos que empieza por 3. Acepta el número con
 * prefijo +57/57, espacios o guiones y devuelve solo los 10 dígitos, o null.
 */
export function normalizeNequiPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('57')) digits = digits.slice(2);
  return /^3\d{9}$/.test(digits) ? digits : null;
}

/** MessageID: Nequi pide un identificador alfanumérico corto por mensaje. */
export function generateMessageId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

export class NequiNotConfiguredError extends Error {
  constructor() {
    super('El cobro con Nequi no está configurado (faltan credenciales de Nequi Conecta).');
  }
}

/** Error de la API: HTTP fallido o StatusCode distinto de "0". */
export class NequiApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: string | null,
    readonly httpStatus: number | null,
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface CachedToken {
  value: string;
  type: string;
  expiresAt: number;
}

/** Se renueva el token un minuto antes de que caduque. */
const TOKEN_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

export class NequiClient {
  private token: CachedToken | null = null;
  private tokenInFlight: Promise<CachedToken> | null = null;

  constructor(
    private readonly config: NequiConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => number = () => Date.now(),
  ) {}

  get configured(): boolean {
    return isNequiConfigured(this.config);
  }

  /** Envía la notificación push. Devuelve el transactionId de Nequi. */
  async sendPushPayment(params: {
    phoneNumber: string;
    value: number;
    reference1?: string;
    reference2?: string;
    reference3?: string;
  }): Promise<{ transactionId: string; messageId: string }> {
    const rq: Record<string, string> = {
      phoneNumber: params.phoneNumber,
      code: this.config.commerceCode!,
      // Nequi espera pesos enteros como texto, sin decimales ni separadores.
      value: String(Math.round(params.value)),
    };
    for (const key of ['reference1', 'reference2', 'reference3'] as const) {
      if (params[key]) rq[key] = params[key]!.slice(0, 30);
    }

    const { body, messageId } = await this.call(
      NEQUI_ENDPOINTS.unregisteredPayment,
      { ServiceName: 'PaymentsService', ServiceOperation: 'unregisteredPayment', ServiceRegion: 'C001', ServiceVersion: '1.2.0' },
      { unregisteredPaymentRQ: rq },
    );

    const transactionId = body?.unregisteredPaymentRS?.transactionId;
    if (typeof transactionId !== 'string' || !transactionId.trim()) {
      throw new NequiApiError('Nequi aceptó el cobro pero no devolvió transactionId', null, null);
    }
    return { transactionId: transactionId.trim(), messageId };
  }

  /** Consulta el estado de un cobro push por su transactionId. */
  async getPaymentStatus(transactionId: string): Promise<{
    state: NequiPaymentState;
    rawStatus: string | null;
    value: number | null;
    trnId: string | null;
  }> {
    const { body } = await this.call(
      NEQUI_ENDPOINTS.getStatusPayment,
      { ServiceName: 'PaymentsService', ServiceOperation: 'getStatusPayment', ServiceRegion: 'C001', ServiceVersion: '1.0.0' },
      { getStatusPaymentRQ: { codeQR: transactionId } },
    );

    const rs = body?.getStatusPaymentRS ?? {};
    const rawStatus = rs.status != null ? String(rs.status) : null;
    const value = Number(rs.value);
    return {
      state: mapNequiStatus(rawStatus),
      rawStatus,
      value: Number.isFinite(value) ? value : null,
      trnId: typeof rs.trnId === 'string' ? rs.trnId : null,
    };
  }

  /** Anula un cobro push que el cliente todavía no ha aceptado. */
  async cancelPushPayment(params: { phoneNumber: string; transactionId: string }): Promise<void> {
    await this.call(
      NEQUI_ENDPOINTS.cancelUnregisteredPayment,
      { ServiceName: 'PaymentsService', ServiceOperation: 'cancelUnregisteredPayment', ServiceRegion: 'C001', ServiceVersion: '1.0.0' },
      {
        cancelUnregisteredPaymentRQ: {
          code: this.config.commerceCode!,
          phoneNumber: params.phoneNumber,
          transactionId: params.transactionId,
        },
      },
    );
  }

  // ---------------------------------------------------------------------------

  private async call(
    path: string,
    destination: Record<string, string>,
    requestBody: Record<string, unknown>,
  ): Promise<{ body: any; messageId: string }> {
    if (!this.configured) throw new NequiNotConfiguredError();

    const token = await this.getToken();
    const messageId = generateMessageId();
    const payload = {
      RequestMessage: {
        RequestHeader: {
          Channel: NEQUI_PUSH_CHANNEL,
          RequestDate: new Date(this.now()).toISOString(),
          MessageID: messageId,
          ClientID: this.config.clientId,
          Destination: destination,
        },
        RequestBody: { any: requestBody },
      },
    };

    const res = await this.fetchImpl(`${this.config.apiBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `${token.type} ${token.value}`,
        'x-api-key': this.config.apiKey!,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const json: any = await res.json().catch(() => null);

    if (res.status === 401 || res.status === 403) {
      // Token revocado antes de tiempo: que la próxima llamada pida otro.
      this.token = null;
    }
    if (!res.ok) {
      throw new NequiApiError(
        json?.message || `Nequi respondió HTTP ${res.status}`,
        null,
        res.status,
      );
    }

    const status = json?.ResponseMessage?.ResponseHeader?.Status;
    const statusCode = status?.StatusCode != null ? String(status.StatusCode) : null;
    if (statusCode !== '0') {
      throw new NequiApiError(
        status?.StatusDesc || 'Nequi rechazó la operación',
        statusCode,
        res.status,
      );
    }

    return { body: json?.ResponseMessage?.ResponseBody?.any ?? {}, messageId };
  }

  private async getToken(): Promise<CachedToken> {
    if (this.token && this.token.expiresAt - TOKEN_SKEW_MS > this.now()) return this.token;
    // Una sola petición de token aunque lleguen varias llamadas a la vez.
    this.tokenInFlight ??= this.fetchToken().finally(() => { this.tokenInFlight = null; });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<CachedToken> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.config.authUrl}?grant_type=client_credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const json: any = await res.json().catch(() => null);
    if (!res.ok || typeof json?.access_token !== 'string') {
      this.token = null;
      throw new NequiApiError(
        `No se pudo autenticar con Nequi (HTTP ${res.status}). Revisa NEQUI_CLIENT_ID / NEQUI_CLIENT_SECRET.`,
        null,
        res.status,
      );
    }

    const expiresIn = Number(json.expires_in);
    this.token = {
      value: json.access_token,
      type: typeof json.token_type === 'string' && json.token_type ? capitalize(json.token_type) : 'Bearer',
      expiresAt: this.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300) * 1000,
    };
    return this.token;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
