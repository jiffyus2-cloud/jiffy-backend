import { OneclicConfig } from './oneclic.config';

/**
 * Cliente HTTP mínimo para la API de 1clic.ai.
 *
 * Aquí viven las reglas que 1clic observa en su prueba de conformidad, para
 * que ningún llamador tenga que acordarse de ellas:
 *
 *  1. La clave viaja como `Authorization: Bearer` en todo salvo `agent_connected`.
 *  4. Todo `POST /run` lleva `Idempotency-Key`.
 *  3. Un run asíncrono se sondea a 2 s → 5 s → 10 s, respetando `Retry-After`.
 *  5. Un 429 con `retryable` se reintenta UNA vez tras `Retry-After`.
 *  6. Un 402 (cartera vacía) no se reintenta jamás.
 *
 * Las otras (external_user_id, response_schema, coste visible, propuesta sin
 * escritura) son responsabilidad del servicio y del panel del frontend.
 */

// ── Tipos del contrato (subconjunto de /api/v1/openapi.json) ─────────────────

export type OneclicErrorCode =
  | 'invalid_request_error' | 'authentication_error' | 'key_expired'
  | 'origin_not_allowed' | 'agent_not_allowed' | 'model_not_found'
  | 'agent_paused' | 'insufficient_quota' | 'budget_reached'
  | 'spend_cap_reached' | 'rate_limit_exceeded' | 'connection_paused'
  | 'paused_by_monitor' | 'setup_code_expired' | 'setup_code_used'
  | 'setup_code_invalid' | 'setup_code_superseded' | 'not_authorized'
  | 'connection_denied' | 'provider_unavailable' | 'upstream_error'
  | 'internal_error' | 'not_found' | 'unknown';

export type OneclicRemediation =
  | 'mint_new_code' | 'provision_key' | 'wait_and_retry' | 'top_up_wallet'
  | 'contact_owner' | 'fix_request' | 'await_authorization' | 'stop';

export interface OneclicAgent {
  id: string | null;
  address: string;
  name: string;
  description: string | null;
  status: string;
  modes: string[];
  runnable: boolean;
}

export interface OneclicAgentsResponse {
  agents: OneclicAgent[];
  test_agent?: { address: string; modes: string[] };
  note?: string;
  assign_url?: string;
}

export interface OneclicRunRequest {
  external_user_id: string;
  message: string;
  context?: unknown;
  response_schema?: Record<string, unknown>;
  mode?: 'default' | 'dry_run';
  async?: boolean;
  conversation_id?: string | null;
}

export interface OneclicRunResult {
  run_id?: string;
  status?: 'queued' | 'success' | 'error';
  reply: string | null;
  error?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string | null;
  cost_usd: number;
  duration_ms: number | null;
  stop_reason?: string | null;
  dry_run?: boolean;
  deduplicated?: boolean;
  /**
   * Presente si se mandó response_schema. `data` es el documento ya validado
   * por 1clic: es lo que hay que leer. `reply` es la propuesta en Markdown (y
   * puede venir con una valla de código json), no se re-parsea.
   */
  typed_response?: { valid: boolean; errors?: string[]; data?: unknown } | null;
}

export type OneclicEventStep =
  | 'agent_connected' | 'code_redeemed' | 'manifest_fetched' | 'key_provisioned'
  | 'repo_scanned' | 'action_added' | 'client_written' | 'tests_written'
  | 'conformance_started' | 'pr_opened' | 'key_installed' | 'webhook_installed'
  | 'merged' | 'done' | 'blocked';

export interface OneclicAttestation { file: string; line: number }

export interface OneclicEvent {
  step: OneclicEventStep;
  status?: 'ok' | 'error' | 'retrying';
  detail?: string;
  duration_ms?: number;
  files?: string[];
  env_var?: string;
  question?: string;
  options?: string[];
  attestations?: { cost_visible?: OneclicAttestation; proposal_only?: OneclicAttestation };
}

export interface OneclicStatusEnvelope {
  connection_id: string;
  state: string;
  signals?: Record<string, string | null>;
  waiting_on?: { kind: string; since: string; url: string } | null;
  conformance?: { passed: number; total: number; failed: string[]; report_url: string } | null;
  next: string;
  next_url?: string | null;
  urls?: Record<string, string | null>;
}

export interface OneclicVerifyOpen {
  session_id: string;
  ref: string;
  expires_at: string;
  instructions: string[];
}

export interface OneclicGradedCheck {
  id: string;
  n: number;
  name: string;
  kind: 'observed' | 'attested';
  status: 'pass' | 'fail' | 'attestation_missing';
  detail: string;
  evidence?: string | null;
  remediation?: string | null;
  fixable_by_agent?: boolean;
}

export interface OneclicVerifyGrade {
  session_id: string;
  ref?: string;
  status: 'complete';
  score: string;
  passed: number;
  failed: number;
  blocked: number;
  can_go_live: boolean;
  cost_usd?: number;
  checks: OneclicGradedCheck[];
  next?: string;
}

// ── Errores ──────────────────────────────────────────────────────────────────

export class OneclicNotConfiguredError extends Error {
  constructor(what: 'apiKey' | 'connectionId') {
    super(
      what === 'apiKey'
        ? 'Falta ONECLIC_API_KEY: canjea el código de configuración y guarda la clave en el entorno del servidor.'
        : 'Falta ONECLIC_CONNECTION_ID: el id de la conexión de 1clic que nombra este despliegue.',
    );
    this.name = 'OneclicNotConfiguredError';
  }
}

/** Error de la API de 1clic ya interpretado desde su sobre de error. */
export class OneclicApiError extends Error {
  readonly name = 'OneclicApiError';
  constructor(
    readonly status: number,
    readonly code: OneclicErrorCode,
    message: string,
    readonly remediation: OneclicRemediation | null,
    readonly remediationEndpoint: string | null,
    readonly retryable: boolean,
    readonly retryAfter: number | null,
    readonly docs: string | null,
  ) {
    super(message);
  }

  toJSON() {
    return {
      status: this.status,
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      remediation_endpoint: this.remediationEndpoint,
      retryable: this.retryable,
      retry_after: this.retryAfter,
      docs: this.docs,
    };
  }
}

/**
 * Convierte una respuesta no-2xx en un OneclicApiError. Si el cuerpo no trae el
 * sobre `{ error: {...} }` (p. ej. un 502 en HTML), se rellena con lo que hay.
 */
export function parseErrorEnvelope(
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null,
): OneclicApiError {
  let envelope: any = null;
  try {
    envelope = JSON.parse(bodyText)?.error ?? null;
  } catch {
    envelope = null;
  }

  // La cabecera Retry-After es la que cuenta (es lo que mide 1clic); si el
  // cuerpo trae un retry_after mayor, se respeta el mayor de los dos.
  const headerRetry = parseRetryAfter(retryAfterHeader);
  const bodyRetry = typeof envelope?.retry_after === 'number' ? Math.max(0, Math.ceil(envelope.retry_after)) : null;
  const retryAfter = headerRetry != null && bodyRetry != null ? Math.max(headerRetry, bodyRetry) : headerRetry ?? bodyRetry;

  if (envelope && typeof envelope === 'object') {
    return new OneclicApiError(
      status,
      (envelope.code as OneclicErrorCode) || 'unknown',
      envelope.message || `1clic respondió HTTP ${status}`,
      envelope.remediation ?? null,
      envelope.remediation_endpoint ?? null,
      Boolean(envelope.retryable),
      retryAfter,
      envelope.docs ?? null,
    );
  }

  const plain = bodyText.replace(/<[^>]*>?/gm, '').trim().slice(0, 300);
  return new OneclicApiError(
    status,
    status === 429 ? 'rate_limit_exceeded' : status >= 500 ? 'upstream_error' : 'unknown',
    plain || `1clic respondió HTTP ${status}`,
    status === 429 || status >= 500 ? 'wait_and_retry' : null,
    null,
    status === 429 || status >= 500,
    retryAfter,
    null,
  );
}

/** `Retry-After` puede venir en segundos o como fecha HTTP. Devuelve segundos. */
export function parseRetryAfter(value?: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

// ── Reglas puras (probadas en oneclic.client.test.ts) ────────────────────────

/** Cadencia de sondeo que exige 1clic: 2 s, 5 s y después siempre 10 s. */
export const POLL_DELAYS_MS = [2000, 5000, 10000] as const;

export function pollDelayMs(attempt: number, retryAfterSeconds?: number | null): number {
  const base = POLL_DELAYS_MS[Math.min(Math.max(attempt, 0), POLL_DELAYS_MS.length - 1)];
  if (retryAfterSeconds != null) return Math.max(base, retryAfterSeconds * 1000);
  return base;
}

/**
 * `Idempotency-Key: <record_id>-<attempt_date>[-<discriminator>]`. La misma
 * clave dentro de 24 h devuelve el mismo run, así que un doble clic no cobra
 * dos veces. El discriminador distingue peticiones DISTINTAS sobre el mismo
 * registro el mismo día (otro mensaje, otro agente, otro modo): sin él, la
 * segunda recibiría la respuesta de la primera.
 */
export function buildIdempotencyKey(recordId: string, attemptDate: Date = new Date(), discriminator?: string): string {
  const safeRecord = String(recordId).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100);
  const suffix = discriminator ? `-${discriminator.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 40)}` : '';
  return `${safeRecord}-${attemptDate.toISOString().slice(0, 10)}${suffix}`;
}

/** Colchón sobre Retry-After: cubre la granularidad del reloj y que la espera empieza tras leer el cuerpo. */
export const RETRY_AFTER_MARGIN_MS = 250;
/** Tope de espera para no dejar colgada una petición HTTP del navegador. */
export const MAX_RETRY_WAIT_MS = 30_000;
export const MAX_POLL_WAIT_MS = 90_000;

// ── Cliente ──────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type SleepLike = (ms: number) => Promise<void>;

const defaultSleep: SleepLike = ms => new Promise(resolve => setTimeout(resolve, ms));

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** `false` solo para `agent_connected`, el único paso sin clave. */
  auth?: boolean;
}

export class OneclicClient {
  constructor(
    private readonly config: OneclicConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly sleep: SleepLike = defaultSleep,
  ) {}

  get isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  get hasConnectionId(): boolean {
    return Boolean(this.config.connectionId);
  }

  private connectionPath(suffix: string): string {
    if (!this.config.connectionId) throw new OneclicNotConfiguredError('connectionId');
    return `/connections/${encodeURIComponent(this.config.connectionId)}/${suffix}`;
  }

  /**
   * Una petición con las reglas de reintento del contrato:
   * - 429 → espera `Retry-After` (la CABECERA; el cuerpo solo si es mayor)
   *   contando desde que llega la respuesta, y reintenta una sola vez.
   * - 5xx → igual, un solo reintento (Retry-After o una espera corta).
   * - 402 → nunca se reintenta.
   *
   * "Una sola vez" es por código de estado, no por petición: la prueba de
   * conformidad de 1clic responde 503 → 429 → 200 a la MISMA petición (misma
   * Idempotency-Key), y cada uno de esos se reintenta una vez. Dos 429
   * seguidos sí se rinden.
   */
  async request<T>(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<{ status: number; data: T }> {
    const { body, headers = {}, auth = true } = options;

    if (auth && !this.config.apiKey) throw new OneclicNotConfiguredError('apiKey');

    const init: RequestInit = {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    const url = `${this.config.apiUrl}${path}`;
    const retried = new Set<number>();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await this.fetchImpl(url, init);
      const text = await response.text();

      if (response.ok) {
        return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
      }

      const error = parseErrorEnvelope(response.status, text, response.headers.get('retry-after'));

      // 402: cartera vacía. Se muestra y se para; reintentar solo repetiría el fallo.
      if (response.status === 402) throw error;

      const transient = response.status === 429 || response.status >= 500;
      const canRetry = transient && !retried.has(response.status) && (error.retryable || error.retryAfter != null);
      if (!canRetry) throw error;

      const waitMs = Math.min(
        (error.retryAfter ?? (response.status === 429 ? 5 : 2)) * 1000 + RETRY_AFTER_MARGIN_MS,
        MAX_RETRY_WAIT_MS,
      );
      retried.add(response.status);
      // El reloj de Retry-After arranca cuando LLEGA la respuesta (no cuando se
      // mandó la petición): la espera empieza aquí, con la respuesta ya en mano.
      await this.sleep(waitMs);
    }
  }

  // ── Canal de estado de la conexión ─────────────────────────────────────

  /** Paso A. Sin clave: solo avisa a la pantalla del dueño de que algo llegó. */
  announce(): Promise<{ status: number; data: { ok: boolean } }> {
    return this.request('POST', this.connectionPath('events'), {
      body: { step: 'agent_connected' },
      auth: false,
    });
  }

  sendEvent(event: OneclicEvent): Promise<{ status: number; data: { ok: boolean; directives?: unknown[] } }> {
    return this.request('POST', this.connectionPath('events'), { body: event });
  }

  /** Público sin clave (estado y `next`); con clave devuelve el sobre completo. */
  getStatus(): Promise<{ status: number; data: OneclicStatusEnvelope }> {
    return this.request('GET', this.connectionPath('status'), { auth: this.isConfigured });
  }

  // ── Agentes y runs ─────────────────────────────────────────────────────

  listAgents(): Promise<{ status: number; data: OneclicAgentsResponse }> {
    return this.request('GET', '/agents');
  }

  /**
   * Lanza un run y, si 1clic lo encola (202), lo sondea hasta que termine.
   * `agentId` es el id que devolvió `listAgents` o `1clic-test`; nunca uno
   * fijo en código.
   */
  async run(agentId: string, body: OneclicRunRequest, idempotencyKey: string): Promise<OneclicRunResult> {
    const { status, data } = await this.request<OneclicRunResult>(
      'POST',
      `/agents/${encodeURIComponent(agentId)}/run`,
      { body, headers: { 'Idempotency-Key': idempotencyKey } },
    );

    if (status !== 202 || !data?.run_id) return data;
    return this.pollRun(agentId, data.run_id);
  }

  async pollRun(agentId: string, runId: string): Promise<OneclicRunResult> {
    const started = Date.now();
    let attempt = 0;
    let lastRetryAfter: number | null = null;

    while (Date.now() - started < MAX_POLL_WAIT_MS) {
      await this.sleep(pollDelayMs(attempt, lastRetryAfter));
      attempt += 1;
      lastRetryAfter = null;

      try {
        const { data } = await this.request<OneclicRunResult>(
          'GET',
          `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
        );
        if (data.status && data.status !== 'queued') return data;
      } catch (error) {
        // Un 429 durante el sondeo no es un fallo del run: se espera lo que pida.
        if (error instanceof OneclicApiError && error.status === 429 && error.retryable) {
          lastRetryAfter = error.retryAfter ?? 10;
          continue;
        }
        throw error;
      }
    }

    throw new OneclicApiError(
      504, 'upstream_error',
      `El run ${runId} sigue en cola tras ${MAX_POLL_WAIT_MS / 1000} s.`,
      'wait_and_retry', null, true, null, null,
    );
  }

  // ── Verificación (paso D) ──────────────────────────────────────────────

  openVerifySession(): Promise<{ status: number; data: OneclicVerifyOpen }> {
    return this.request('POST', this.connectionPath('verify'), { body: {} });
  }

  gradeVerifySession(
    sessionId: string,
    attestations: OneclicEvent['attestations'],
  ): Promise<{ status: number; data: OneclicVerifyGrade }> {
    return this.request('POST', this.connectionPath('verify'), {
      body: { session_id: sessionId, attestations },
    });
  }
}
