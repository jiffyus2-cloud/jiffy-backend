import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { readOneclicConfig, ONECLIC_API_KEY_ENV, ONECLIC_CONNECTION_ID_ENV } from './oneclic.config';
import {
  OneclicAgent,
  OneclicApiError,
  OneclicAttestation,
  OneclicClient,
  OneclicNotConfiguredError,
  OneclicRunResult,
  OneclicStatusEnvelope,
  OneclicVerifyGrade,
  OneclicVerifyOpen,
  buildIdempotencyKey,
} from './oneclic.client';

/** Id del agente de prueba: responde en seco, a $0.00, con cualquier clave. */
export const ONECLIC_TEST_AGENT_ID = '1clic-test';

/** Límite del contrato para `context` (manifest.limits.context_chars). */
const CONTEXT_MAX_CHARS = 8000;

/**
 * Lo que le pedimos al agente que devuelva. Se manda como `response_schema`
 * para consumir JSON y no prosa (regla 9 de conformidad).
 */
export const PROPOSAL_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['summary', 'proposal'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'Una frase: qué propone y por qué.' },
    proposal: { type: 'string', description: 'La propuesta completa, en Markdown.' },
    actions: {
      type: 'array',
      description: 'Pasos concretos que una persona tendría que aprobar.',
      items: { type: 'string' },
    },
  },
} as const;

export interface ProposalRequest {
  /** uid de Firebase de quien pide la propuesta; nunca sale de aquí en claro. */
  uid: string;
  /** Id de agente devuelto por `GET /agents`, o `1clic-test`. */
  agentId: string;
  message: string;
  /** Registro al que se aplica (p. ej. un pedido); ancla la Idempotency-Key. */
  recordId: string;
  context?: unknown;
  mode?: 'default' | 'dry_run';
}

export interface Proposal {
  run_id: string | null;
  agent: { id: string; name: string };
  summary: string;
  proposal: string;
  actions: string[];
  /** Coste y duración van juntos a la pantalla, al lado de la propuesta. */
  cost_usd: number;
  duration_ms: number | null;
  dry_run: boolean;
  deduplicated: boolean;
  typed_response: { valid: boolean; errors?: string[] } | null;
  raw_reply: string | null;
}

export interface OneclicOverview {
  configured: { api_key: boolean; connection_id: boolean };
  env_vars: { api_key: string; connection_id: string };
  status: OneclicStatusEnvelope | null;
  agents: OneclicAgent[];
  test_agent: { address: string; modes: string[] } | null;
  agents_note: string | null;
  assign_url: string | null;
  error: ReturnType<OneclicApiError['toJSON']> | { code: string; message: string } | null;
}

export interface VerifyReport {
  session: Pick<OneclicVerifyOpen, 'session_id' | 'ref' | 'expires_at' | 'instructions'>;
  exercise: { step: string; ok: boolean; detail: string }[];
  grade: OneclicVerifyGrade;
}

@Injectable()
export class OneclicService {
  private readonly logger = new Logger('1clic');
  private readonly client: OneclicClient;

  constructor() {
    this.client = this.createClient();
  }

  /** Punto de sustitución para los tests (sin parámetros en el constructor: Nest no tiene que inyectar nada). */
  protected createClient(): OneclicClient {
    return new OneclicClient(readOneclicConfig());
  }

  /**
   * Pseudónimo estable por persona (regla 2): el mismo uid produce siempre el
   * mismo valor, y de él no se puede recuperar el uid ni el correo.
   */
  static externalUserId(uid: string): string {
    return createHash('sha256').update(`jiffyphotos:${uid}`).digest('hex').slice(0, 64);
  }

  /**
   * Huella corta de lo que se pide, para la Idempotency-Key: dos peticiones
   * sobre el mismo registro el mismo día solo se consideran repetidas si
   * piden lo mismo, al mismo agente, en el mismo modo.
   */
  static requestFingerprint(agentId: string, mode: string, message: string): string {
    return createHash('sha256').update([agentId, mode, message].join('\n')).digest('hex').slice(0, 12);
  }

  // ── Estado para el panel del dueño ─────────────────────────────────────

  async overview(): Promise<OneclicOverview> {
    const overview: OneclicOverview = {
      configured: { api_key: this.client.isConfigured, connection_id: this.client.hasConnectionId },
      env_vars: { api_key: ONECLIC_API_KEY_ENV, connection_id: ONECLIC_CONNECTION_ID_ENV },
      status: null,
      agents: [],
      test_agent: null,
      agents_note: null,
      assign_url: null,
      error: null,
    };

    try {
      if (this.client.hasConnectionId) {
        overview.status = (await this.client.getStatus()).data;
      }
      if (this.client.isConfigured) {
        const { data } = await this.client.listAgents();
        overview.agents = data.agents ?? [];
        overview.test_agent = data.test_agent ?? null;
        overview.agents_note = data.note ?? null;
        overview.assign_url = data.assign_url ?? null;
      }
    } catch (error) {
      overview.error = this.describe(error);
    }

    return overview;
  }

  // ── La acción: pedir una propuesta ─────────────────────────────────────

  async propose(request: ProposalRequest): Promise<Proposal> {
    const message = String(request.message || '').trim();
    if (!message) throw new BadRequestException('Escribe qué quieres pedirle al agente.');
    if (!request.recordId) throw new BadRequestException('Falta el registro al que se aplica la propuesta.');

    const agent = await this.resolveAgent(request.agentId);
    // Un run real gasta de la cartera: solo si se pide 'default' con todas
    // las letras. Un modo ausente o mal escrito se queda en seco.
    const mode = agent.id !== ONECLIC_TEST_AGENT_ID && request.mode === 'default' ? 'default' : 'dry_run';

    const context = trimContext(request.context);

    let result: OneclicRunResult;
    try {
      result = await this.client.run(
        agent.id,
        {
          external_user_id: OneclicService.externalUserId(request.uid),
          message,
          ...(context !== undefined ? { context } : {}),
          response_schema: PROPOSAL_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
          mode,
        },
        buildIdempotencyKey(request.recordId, new Date(), OneclicService.requestFingerprint(agent.id, mode, message)),
      );
    } catch (error) {
      throw this.toHttp(error);
    }

    if (result.status === 'error' || (result.reply == null && result.error)) {
      // Un run que acabó mal no es una propuesta vacía: se dice qué pasó.
      throw new HttpException(
        { code: 'run_failed', message: result.error || 'El agente no devolvió respuesta.', run_id: result.run_id ?? null, cost_usd: result.cost_usd ?? 0 },
        502,
      );
    }

    return OneclicService.toProposal(result, agent);
  }

  /**
   * El agente tiene que ser uno que `GET /agents` devuelva para esta clave, o
   * el de prueba. Nada de ids por defecto: un id que nadie eligió es peor que
   * una negativa.
   */
  private async resolveAgent(agentId: string): Promise<{ id: string; name: string }> {
    const wanted = String(agentId || '').trim();
    if (!wanted) throw new BadRequestException('Elige un agente.');

    if (wanted === ONECLIC_TEST_AGENT_ID || wanted === `agent:${ONECLIC_TEST_AGENT_ID}`) {
      return { id: ONECLIC_TEST_AGENT_ID, name: 'Agente de prueba de 1clic' };
    }

    let agents: OneclicAgent[];
    try {
      agents = (await this.client.listAgents()).data.agents ?? [];
    } catch (error) {
      throw this.toHttp(error);
    }

    const match = agents.find(a => a.id === wanted || a.address === wanted);
    if (!match || !match.id) {
      throw new HttpException(
        {
          code: 'agent_not_allowed',
          message: 'Ese agente no está asignado a esta conexión. El dueño lo asigna desde 1clic y aparece aquí sin cambiar nada.',
          remediation: 'contact_owner',
        },
        403,
      );
    }
    return { id: match.id, name: match.name };
  }

  static toProposal(result: OneclicRunResult, agent: { id: string; name: string }): Proposal {
    const parsed = parseTypedReply(result.reply);
    return {
      run_id: result.run_id ?? null,
      agent,
      summary: parsed?.summary ?? '',
      proposal: parsed?.proposal ?? (result.reply ?? ''),
      actions: parsed?.actions ?? [],
      cost_usd: Number(result.cost_usd) || 0,
      duration_ms: result.duration_ms ?? null,
      dry_run: Boolean(result.dry_run),
      deduplicated: Boolean(result.deduplicated),
      typed_response: result.typed_response ?? null,
      raw_reply: result.reply ?? null,
    };
  }

  // ── Verificación (paso D): la plataforma se examina a sí misma ─────────

  /**
   * Abre una sesión de conformidad, ejercita la integración contra el agente
   * de prueba (en seco, $0.00) y pide la nota. Las dos comprobaciones que
   * 1clic no puede observar (coste visible, propuesta sin escritura) se
   * atestiguan con `archivo:línea` del panel del frontend.
   */
  async verify(attestations: {
    cost_visible?: OneclicAttestation;
    proposal_only?: OneclicAttestation;
  }): Promise<VerifyReport> {
    validateAttestations(attestations);

    let open: OneclicVerifyOpen;
    try {
      open = (await this.client.openVerifySession()).data;
    } catch (error) {
      throw this.toHttp(error);
    }
    this.logger.log(`Sesión de conformidad ${open.ref} abierta (${open.session_id}).`);
    open.instructions?.forEach((line, i) => this.logger.log(`  ${i + 1}. ${line}`));

    const exercise: VerifyReport['exercise'] = [];
    const record = async (step: string, fn: () => Promise<string>) => {
      try {
        exercise.push({ step, ok: true, detail: await fn() });
      } catch (error) {
        // Un error de la API durante el ejercicio es parte de la prueba (429,
        // 402 sintéticos): se anota lo que pasó y se sigue con el siguiente.
        exercise.push({ step, ok: false, detail: this.describe(error).message });
      }
    };

    const verifierUid = `conformance:${open.session_id}`;
    const runBody = (message: string) => ({
      external_user_id: OneclicService.externalUserId(verifierUid),
      message,
      context: { ref: open.ref, purpose: 'conformance' },
      response_schema: PROPOSAL_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      mode: 'dry_run' as const,
    });

    await record('agents', async () => {
      const { data } = await this.client.listAgents();
      return `${data.agents?.length ?? 0} agente(s) asignado(s); agente de prueba ${data.test_agent?.address ?? 'n/d'}.`;
    });

    await record('run_sync', async () => {
      const result = await this.client.run(
        ONECLIC_TEST_AGENT_ID,
        runBody(`Tarea sintética ${open.ref}: propón un resumen de un pedido de ejemplo.`),
        buildIdempotencyKey(open.session_id, new Date(), 'sync'),
      );
      return `run ${result.run_id ?? 'n/d'} · typed=${result.typed_response?.valid ?? 'n/d'} · $${result.cost_usd ?? 0} · ${result.duration_ms ?? '?'} ms`;
    });

    await record('run_sync_replay', async () => {
      // Misma Idempotency-Key (sesión + fecha + 'sync'): debe volver el mismo run.
      const result = await this.client.run(
        ONECLIC_TEST_AGENT_ID,
        runBody(`Tarea sintética ${open.ref}: propón un resumen de un pedido de ejemplo.`),
        buildIdempotencyKey(open.session_id, new Date(), 'sync'),
      );
      return `run ${result.run_id ?? 'n/d'} · deduplicated=${Boolean(result.deduplicated)}`;
    });

    await record('run_async', async () => {
      const result = await this.client.run(
        ONECLIC_TEST_AGENT_ID,
        { ...runBody(`Tarea sintética ${open.ref} (asíncrona).`), async: true },
        buildIdempotencyKey(open.session_id, new Date(), 'async'),
      );
      return `run ${result.run_id ?? 'n/d'} · status=${result.status ?? 'n/d'}`;
    });

    let grade: OneclicVerifyGrade;
    try {
      grade = (await this.client.gradeVerifySession(open.session_id, attestations)).data;
    } catch (error) {
      throw this.toHttp(error);
    }
    this.logger.log(`Conformidad ${open.ref}: ${grade.score} · can_go_live=${grade.can_go_live}`);

    return {
      session: {
        session_id: open.session_id,
        ref: open.ref,
        expires_at: open.expires_at,
        instructions: open.instructions ?? [],
      },
      exercise,
      grade,
    };
  }

  // ── Errores ────────────────────────────────────────────────────────────

  private describe(error: unknown): OneclicOverview['error'] & object {
    if (error instanceof OneclicApiError) return error.toJSON();
    if (error instanceof OneclicNotConfiguredError) return { code: 'not_configured', message: error.message };
    const message = (error as Error)?.message || 'Error desconocido hablando con 1clic.';
    this.logger.error(message);
    return { code: 'network_error', message };
  }

  /**
   * Traduce a HTTP conservando el sobre de 1clic, que ya dice qué hacer. El
   * 403 `agent_not_allowed` NO es un fallo de integración: la clave vale y solo
   * falta que el dueño asigne un agente.
   */
  private toHttp(error: unknown): HttpException {
    if (error instanceof HttpException) return error;
    if (error instanceof OneclicApiError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return new HttpException(error.toJSON(), status);
    }
    if (error instanceof OneclicNotConfiguredError) {
      return new HttpException({ code: 'not_configured', message: error.message }, 503);
    }
    const message = (error as Error)?.message || 'No se pudo contactar con 1clic.';
    this.logger.error(message);
    return new HttpException({ code: 'network_error', message }, 502);
  }
}

// ── Utilidades puras ─────────────────────────────────────────────────────────

function trimContext(context: unknown): unknown {
  if (context === undefined || context === null) return undefined;
  const text = JSON.stringify(context);
  if (text.length <= CONTEXT_MAX_CHARS) return context;
  // Mejor un contexto recortado que un 400 por tamaño: el agente ve lo que cabe.
  return { truncated: true, text: text.slice(0, CONTEXT_MAX_CHARS - 40) };
}

export function parseTypedReply(reply: string | null): { summary: string; proposal: string; actions: string[] } | null {
  if (!reply) return null;
  try {
    const parsed = JSON.parse(reply);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      proposal: typeof parsed.proposal === 'string' ? parsed.proposal : String(reply),
      actions: Array.isArray(parsed.actions) ? parsed.actions.filter((a: unknown) => typeof a === 'string') : [],
    };
  } catch {
    return null;
  }
}

function validateAttestations(attestations: Record<string, OneclicAttestation | undefined>): void {
  for (const key of ['cost_visible', 'proposal_only'] as const) {
    const a = attestations?.[key];
    if (!a) throw new BadRequestException(`Falta la atestación "${key}" (archivo y línea).`);
    if (typeof a.file !== 'string' || !a.file.trim() || a.file.length > 200) {
      throw new BadRequestException(`La atestación "${key}" necesita un archivo válido.`);
    }
    if (!Number.isInteger(a.line) || a.line < 1) {
      throw new BadRequestException(`La atestación "${key}" necesita una línea (entero ≥ 1).`);
    }
  }
}
