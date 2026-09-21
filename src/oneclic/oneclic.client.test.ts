import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  OneclicApiError,
  OneclicClient,
  OneclicNotConfiguredError,
  buildIdempotencyKey,
  parseErrorEnvelope,
  parseRetryAfter,
  pollDelayMs,
} from './oneclic.client';
import { HttpException } from '@nestjs/common';
import { OneclicService, parseTypedReply } from './oneclic.service';

// Se ejecutan sobre el JS compilado (ver el script `test` de package.json).

const CONFIG = { apiKey: '1cg_test', connectionId: 'conn-1', apiUrl: 'https://1clic.test/api/v1' };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function envelope(code: string, extra: Record<string, unknown> = {}) {
  return {
    error: {
      code, message: `msg ${code}`, remediation: 'stop', remediation_endpoint: null,
      retryable: false, retry_after: null, docs: null, ...extra,
    },
  };
}

/** fetch falso que devuelve las respuestas en orden y registra cada llamada. */
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

function fakeSleep() {
  const waits: number[] = [];
  return { impl: async (ms: number) => { waits.push(ms); }, waits };
}

describe('reglas puras', () => {
  it('Idempotency-Key = <record>-<fecha>[-<discriminador>]', () => {
    assert.equal(buildIdempotencyKey('order_42', new Date('2026-09-14T23:59:00Z')), 'order_42-2026-09-14');
    assert.equal(buildIdempotencyKey('a/b c', new Date('2026-01-02T00:00:00Z')), 'a_b_c-2026-01-02');
    assert.equal(buildIdempotencyKey('order_42', new Date('2026-09-14T00:00:00Z'), 'abc123'), 'order_42-2026-09-14-abc123');
  });

  it('la huella distingue mensaje, agente y modo sobre el mismo registro', () => {
    const base = OneclicService.requestFingerprint('agent-1', 'dry_run', 'hola');
    assert.match(base, /^[0-9a-f]{12}$/);
    assert.equal(base, OneclicService.requestFingerprint('agent-1', 'dry_run', 'hola'));
    assert.notEqual(base, OneclicService.requestFingerprint('agent-1', 'dry_run', 'adiós'));
    assert.notEqual(base, OneclicService.requestFingerprint('agent-2', 'dry_run', 'hola'));
    assert.notEqual(base, OneclicService.requestFingerprint('agent-1', 'default', 'hola'));
  });

  it('cadencia de sondeo 2s → 5s → 10s, y Retry-After manda si es mayor', () => {
    assert.deepEqual([0, 1, 2, 3, 9].map(a => pollDelayMs(a)), [2000, 5000, 10000, 10000, 10000]);
    assert.equal(pollDelayMs(0, 7), 7000);
    assert.equal(pollDelayMs(2, 1), 10000);
  });

  it('Retry-After acepta segundos o fecha HTTP', () => {
    assert.equal(parseRetryAfter('3'), 3);
    assert.equal(parseRetryAfter(null), null);
    const now = Date.parse('2026-09-14T10:00:00Z');
    assert.equal(parseRetryAfter('Mon, 14 Sep 2026 10:00:30 GMT', now), 30);
  });

  it('el sobre de error se interpreta; sin sobre, se rellena por status', () => {
    const e = parseErrorEnvelope(429, JSON.stringify(envelope('rate_limit_exceeded', { retryable: true, retry_after: 4 })));
    assert.equal(e.code, 'rate_limit_exceeded');
    assert.equal(e.retryable, true);
    assert.equal(e.retryAfter, 4);

    const html = parseErrorEnvelope(502, '<html>Bad gateway</html>');
    assert.equal(html.code, 'upstream_error');
    assert.equal(html.retryable, true);
    assert.equal(html.message, 'Bad gateway');
  });

  it('external_user_id es estable y no es el uid ni un correo', () => {
    const a = OneclicService.externalUserId('uid-123');
    assert.equal(a, OneclicService.externalUserId('uid-123'));
    assert.notEqual(a, OneclicService.externalUserId('uid-124'));
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('la respuesta tipada se consume como JSON (con o sin valla json) y la prosa se conserva', () => {
    assert.deepEqual(parseTypedReply('{"summary":"s","proposal":"p","actions":["x",1]}'), {
      summary: 's', proposal: 'p', actions: ['x'],
    });
    assert.deepEqual(parseTypedReply('```json\n{"summary":"s","proposal":"p"}\n```'), {
      summary: 's', proposal: 'p', actions: [],
    });
    assert.equal(parseTypedReply('texto plano'), null);
    assert.equal(parseTypedReply(null), null);
  });

  it('toProposal lee typed_response.data y no re-parsea reply', () => {
    const proposal = OneclicService.toProposal({
      run_id: 'r', reply: '```json\n{"summary":"del reply","proposal":"x"}\n```', cost_usd: 0, duration_ms: 1,
      typed_response: { valid: true, errors: [], data: { summary: 'del documento', proposal: 'p', actions: null } },
    }, { id: '1clic-test', name: 'T' });
    assert.equal(proposal.summary, 'del documento');
    assert.equal(proposal.proposal, 'p');
    assert.deepEqual(proposal.actions, []);

    // Sin documento válido: respaldo sobre reply, y si es prosa se muestra tal cual.
    const prose = OneclicService.toProposal({
      run_id: 'r', reply: 'No tengo detalles de la tarea.', cost_usd: 0, duration_ms: 1,
      typed_response: { valid: false, errors: ['reply is not JSON'], data: null },
    }, { id: '1clic-test', name: 'T' });
    assert.equal(prose.summary, '');
    assert.equal(prose.proposal, 'No tengo detalles de la tarea.');
  });
});

describe('OneclicClient', () => {
  it('sin clave, solo agent_connected puede salir', async () => {
    const { impl, calls } = fakeFetch([jsonResponse(202, { ok: true })]);
    const client = new OneclicClient({ ...CONFIG, apiKey: null }, impl, fakeSleep().impl);

    await assert.rejects(client.listAgents(), OneclicNotConfiguredError);

    const { status } = await client.announce();
    assert.equal(status, 202);
    assert.equal(calls[0].url, 'https://1clic.test/api/v1/connections/conn-1/events');
    assert.equal((calls[0].init!.headers as Record<string, string>).Authorization, undefined);
    assert.equal(calls[0].init!.body, JSON.stringify({ step: 'agent_connected' }));
  });

  it('manda Bearer e Idempotency-Key en cada run', async () => {
    const { impl, calls } = fakeFetch([jsonResponse(200, { run_id: 'r1', reply: 'ok', cost_usd: 0, duration_ms: 5 })]);
    const client = new OneclicClient(CONFIG, impl, fakeSleep().impl);

    const result = await client.run('agent-1', { external_user_id: 'u', message: 'hola' }, 'order_1-2026-09-14');

    assert.equal(result.run_id, 'r1');
    const headers = calls[0].init!.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer 1cg_test');
    assert.equal(headers['Idempotency-Key'], 'order_1-2026-09-14');
    assert.equal(calls[0].url, 'https://1clic.test/api/v1/agents/agent-1/run');
  });

  it('429 retryable: espera Retry-After y reintenta una sola vez', async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse(429, envelope('rate_limit_exceeded', { retryable: true, retry_after: 2 }), { 'retry-after': '2' }),
      jsonResponse(200, { agents: [] }),
    ]);
    const sleep = fakeSleep();
    const client = new OneclicClient(CONFIG, impl, sleep.impl);

    const { data } = await client.listAgents();
    assert.deepEqual(data, { agents: [] });
    assert.equal(calls.length, 2);
    assert.deepEqual(sleep.waits, [2250]);
  });

  it('Retry-After: manda la cabecera, contada desde que llega el 429; el cuerpo solo si pide más', async () => {
    // 1clic mide la cabecera. Un retry_after menor en el cuerpo no acorta la espera…
    const a = fakeFetch([
      jsonResponse(429, envelope('rate_limit_exceeded', { retryable: true, retry_after: 2 }), { 'retry-after': '3' }),
      jsonResponse(200, { agents: [] }),
    ]);
    const sleepA = fakeSleep();
    await new OneclicClient(CONFIG, a.impl, sleepA.impl).listAgents();
    assert.deepEqual(sleepA.waits, [3250]);

    // …y uno mayor sí la alarga.
    const b = fakeFetch([
      jsonResponse(429, envelope('rate_limit_exceeded', { retryable: true, retry_after: 6 }), { 'retry-after': '3' }),
      jsonResponse(200, { agents: [] }),
    ]);
    const sleepB = fakeSleep();
    await new OneclicClient(CONFIG, b.impl, sleepB.impl).listAgents();
    assert.deepEqual(sleepB.waits, [6250]);
  });

  it('guion de conformidad: 503 → 429 → 200 a la misma petición, un reintento por código y la misma Idempotency-Key', async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse(503, envelope('provider_unavailable', { retryable: true }), { 'retry-after': '5' }),
      jsonResponse(429, envelope('rate_limit_exceeded', { retryable: true }), { 'retry-after': '3' }),
      jsonResponse(200, { run_id: 'r1', reply: 'ok', cost_usd: 0, duration_ms: 5 }),
    ]);
    const sleep = fakeSleep();
    const client = new OneclicClient(CONFIG, impl, sleep.impl);

    const result = await client.run('1clic-test', { external_user_id: 'u', message: 'm' }, 'sess-2026-09-21-scripted-1');

    assert.equal(result.run_id, 'r1');
    assert.equal(calls.length, 3);
    assert.deepEqual(sleep.waits, [5250, 3250]);
    const keys = calls.map(c => (c.init!.headers as Record<string, string>)['Idempotency-Key']);
    assert.deepEqual(keys, ['sess-2026-09-21-scripted-1', 'sess-2026-09-21-scripted-1', 'sess-2026-09-21-scripted-1']);
  });

  it('guion de conformidad: 503 → 429 → 402 para; el 402 no se reintenta', async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse(503, envelope('provider_unavailable', { retryable: true }), { 'retry-after': '5' }),
      jsonResponse(429, envelope('rate_limit_exceeded', { retryable: true }), { 'retry-after': '3' }),
      jsonResponse(402, envelope('insufficient_quota', { retryable: false })),
    ]);
    const sleep = fakeSleep();
    const client = new OneclicClient(CONFIG, impl, sleep.impl);

    await assert.rejects(
      client.run('1clic-test', { external_user_id: 'u', message: 'm' }, 'k'),
      (e: OneclicApiError) => e.status === 402 && e.code === 'insufficient_quota',
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(sleep.waits, [5250, 3250]);
  });

  it('429 que se repite: falla tras el único reintento', async () => {
    const limited = () => jsonResponse(429, envelope('rate_limit_exceeded', { retryable: true, retry_after: 1 }));
    const { impl, calls } = fakeFetch([limited(), limited(), limited()]);
    const client = new OneclicClient(CONFIG, impl, fakeSleep().impl);

    await assert.rejects(client.listAgents(), (e: OneclicApiError) => e.status === 429);
    assert.equal(calls.length, 2);
  });

  it('429 por tope de gasto (no retryable) no se reintenta', async () => {
    const { impl, calls } = fakeFetch([jsonResponse(429, envelope('spend_cap_reached', { retryable: false }))]);
    const client = new OneclicClient(CONFIG, impl, fakeSleep().impl);

    await assert.rejects(client.listAgents(), (e: OneclicApiError) => e.code === 'spend_cap_reached');
    assert.equal(calls.length, 1);
  });

  it('402 cartera vacía: nunca se reintenta, aunque diga retryable', async () => {
    const { impl, calls } = fakeFetch([jsonResponse(402, envelope('insufficient_quota', { retryable: true, retry_after: 1 }))]);
    const sleep = fakeSleep();
    const client = new OneclicClient(CONFIG, impl, sleep.impl);

    await assert.rejects(
      client.run('a', { external_user_id: 'u', message: 'm' }, 'k'),
      (e: OneclicApiError) => e.status === 402 && e.code === 'insufficient_quota',
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(sleep.waits, []);
  });

  it('202: sondea a 2s, 5s, 10s hasta que el run termina', async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse(202, { run_id: 'r9', status: 'queued' }),
      jsonResponse(200, { run_id: 'r9', status: 'queued' }),
      jsonResponse(200, { run_id: 'r9', status: 'queued' }),
      jsonResponse(200, { run_id: 'r9', status: 'queued' }),
      jsonResponse(200, { run_id: 'r9', status: 'success', reply: 'listo', cost_usd: 0.01, duration_ms: 900 }),
    ]);
    const sleep = fakeSleep();
    const client = new OneclicClient(CONFIG, impl, sleep.impl);

    const result = await client.run('a', { external_user_id: 'u', message: 'm', async: true }, 'k');

    assert.equal(result.reply, 'listo');
    assert.deepEqual(sleep.waits, [2000, 5000, 10000, 10000]);
    assert.equal(calls[1].url, 'https://1clic.test/api/v1/agents/a/runs/r9');
    assert.equal(calls.length, 5);
  });

  it('un 429 durante el sondeo respeta Retry-After y sigue sondeando', async () => {
    const { impl } = fakeFetch([
      jsonResponse(202, { run_id: 'r2', status: 'queued' }),
      jsonResponse(429, envelope('rate_limit_exceeded', { retryable: true, retry_after: 20 })),
      jsonResponse(200, { run_id: 'r2', status: 'queued' }),
      jsonResponse(200, { run_id: 'r2', status: 'success', reply: 'x', cost_usd: 0, duration_ms: 1 }),
    ]);
    const sleep = fakeSleep();
    const client = new OneclicClient(CONFIG, impl, sleep.impl);

    const result = await client.run('a', { external_user_id: 'u', message: 'm', async: true }, 'k');

    assert.equal(result.reply, 'x');
    // El 429 lo absorbe request(): espera los 20 s de Retry-After y repite
    // la misma lectura; después el sondeo sigue con su cadencia (5 s).
    assert.deepEqual(sleep.waits, [2000, 20250, 5000]);
  });

  it('403 agent_not_allowed llega entero, con su remediación', async () => {
    const { impl } = fakeFetch([jsonResponse(403, envelope('agent_not_allowed', { remediation: 'contact_owner', remediation_endpoint: 'GET /api/v1/agents' }))]);
    const client = new OneclicClient(CONFIG, impl, fakeSleep().impl);

    await assert.rejects(
      client.run('nobody', { external_user_id: 'u', message: 'm' }, 'k'),
      (e: OneclicApiError) => e.code === 'agent_not_allowed' && e.remediation === 'contact_owner' && e.remediationEndpoint === 'GET /api/v1/agents',
    );
  });
});

// ── Servicio: propose() con un cliente falso ─────────────────────────────────

function serviceWith(responses: Response[]) {
  const { impl, calls } = fakeFetch(responses);
  class TestService extends OneclicService {
    protected createClient() { return new OneclicClient(CONFIG, impl, fakeSleep().impl); }
  }
  return { service: new TestService(), calls };
}

const AGENTS = { agents: [{ id: 'agent-x', address: 'agent:x', name: 'X', description: null, status: 'active', modes: ['default'], runnable: true }] };
const OK_RUN = { run_id: 'r1', status: 'success', reply: '{"summary":"s","proposal":"p"}', cost_usd: 0, duration_ms: 3 };

describe('OneclicService.propose', () => {
  it('sin mode explícito "default", un agente asignado corre en seco', async () => {
    const { service, calls } = serviceWith([jsonResponse(200, AGENTS), jsonResponse(200, OK_RUN)]);
    await service.propose({ uid: 'u', agentId: 'agent-x', message: 'hola', recordId: 'ORD-1' });
    assert.equal(JSON.parse(calls[1].init!.body as string).mode, 'dry_run');

    const real = serviceWith([jsonResponse(200, AGENTS), jsonResponse(200, OK_RUN)]);
    await real.service.propose({ uid: 'u', agentId: 'agent-x', message: 'hola', recordId: 'ORD-1', mode: 'default' });
    assert.equal(JSON.parse(real.calls[1].init!.body as string).mode, 'default');
  });

  it('la Idempotency-Key cambia si cambia el mensaje sobre el mismo registro', async () => {
    const a = serviceWith([jsonResponse(200, OK_RUN)]);
    await a.service.propose({ uid: 'u', agentId: '1clic-test', message: 'mensaje de envío', recordId: 'ORD-1' });
    const b = serviceWith([jsonResponse(200, OK_RUN)]);
    await b.service.propose({ uid: 'u', agentId: '1clic-test', message: 'respuesta a la queja', recordId: 'ORD-1' });
    const keyA = (a.calls[0].init!.headers as Record<string, string>)['Idempotency-Key'];
    const keyB = (b.calls[0].init!.headers as Record<string, string>)['Idempotency-Key'];
    assert.match(keyA, /^ORD-1-\d{4}-\d{2}-\d{2}-[0-9a-f]{12}$/);
    assert.notEqual(keyA, keyB);
  });

  it('un run que acaba en error no es una propuesta vacía: 502 run_failed', async () => {
    const { service } = serviceWith([
      jsonResponse(202, { run_id: 'r9', status: 'queued' }),
      jsonResponse(200, { run_id: 'r9', status: 'error', error: 'model timed out', reply: null, cost_usd: 0.03, duration_ms: 900 }),
    ]);
    await assert.rejects(
      service.propose({ uid: 'u', agentId: '1clic-test', message: 'hola', recordId: 'ORD-1' }),
      (e: HttpException) => e.getStatus() === 502 && (e.getResponse() as any).code === 'run_failed' && (e.getResponse() as any).message === 'model timed out',
    );
  });
});
