import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import type { Config } from './config.js';
import type { JsonObject } from './domain.js';
import type { Logger } from './logger.js';
import { createMetrics } from './metrics.js';
import {
  IdempotencyConflictError,
  InvalidTransitionError,
  JobNotFoundError,
  type QueueStore,
} from './store.js';
import { errorMessage } from './util.js';

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const allowedTypes = ['noop', 'flaky', 'always_fail', 'idempotent_counter'] as const;
const submitSchema = z.object({
  queue: z.string().min(1).max(64).regex(namePattern).default('default'),
  type: z.enum(allowedTypes),
  payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(-100).max(100).default(0),
  available_at: z.iso.datetime({ offset: true }).optional(),
  max_attempts: z.number().int().min(1).max(100).default(5),
  timeout_ms: z.number().int().min(100).max(3_600_000).default(300_000),
  backoff_base_ms: z.number().int().min(1).max(3_600_000).default(500),
  backoff_cap_ms: z.number().int().min(1).max(86_400_000).default(60_000),
}).strict().superRefine((value, context) => {
  if (value.backoff_cap_ms < value.backoff_base_ms) {
    context.addIssue({ code: 'custom', path: ['backoff_cap_ms'], message: 'must be greater than or equal to backoff_base_ms' });
  }
  if (value.available_at && new Date(value.available_at).getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
    context.addIssue({ code: 'custom', path: ['available_at'], message: 'cannot be more than one year in the future' });
  }
});

const uuidParam = z.object({ id: z.uuid() });
const deadParam = z.object({ jobId: z.uuid() });
const benchmarkParam = z.object({ runId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/) });
const listSchema = z.object({
  status: z.enum(['queued', 'running', 'retry_wait', 'succeeded', 'dead_lettered', 'cancelled']).optional(),
  queue: z.string().max(64).optional(),
  type: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});

function idempotencyKey(request: FastifyRequest, required = false): string | undefined {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value && required) throw new z.ZodError([{ code: 'custom', path: ['headers', 'idempotency-key'], message: 'Idempotency-Key header is required', input: undefined }]);
  if (value && (value.length > 255 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new z.ZodError([{ code: 'custom', path: ['headers', 'idempotency-key'], message: 'Idempotency-Key must be 1-255 visible characters', input: value }]);
  }
  return value;
}

function clientId(request: FastifyRequest): string {
  const raw = request.headers['x-client-id'];
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? 'public';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new z.ZodError([{ code: 'custom', path: ['headers', 'x-client-id'], message: 'X-Client-Id is invalid', input: value }]);
  }
  return value;
}

function encodeCursor(job: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: job.created_at, id: job.id })).toString('base64url');
}

function decodeCursor(value?: string): { createdAt: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    return z.object({ createdAt: z.iso.datetime({ offset: true }), id: z.uuid() })
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new z.ZodError([{ code: 'custom', path: ['query', 'cursor'], message: 'Cursor is malformed', input: value }]);
  }
}

export async function buildApi(store: QueueStore, config: Config, logger: Logger) {
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    requestTimeout: 15_000,
    trustProxy: false,
    genReqId: () => crypto.randomUUID(),
  });
  const metrics = createMetrics();
  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin, methods: ['GET', 'POST', 'OPTIONS'] });

  app.addHook('onRequest', async (request) => {
    (request as FastifyRequest & { queueforgeStartedAt: bigint }).queueforgeStartedAt = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (request, reply) => {
    const started = (request as FastifyRequest & { queueforgeStartedAt?: bigint }).queueforgeStartedAt;
    const route = request.routeOptions.url || 'unmatched';
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    metrics.httpRequests.inc(labels);
    if (started) metrics.httpDuration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
  });

  app.setErrorHandler((error, request, reply) => {
    let status = 500;
    let type = 'https://queueforge.dev/problems/internal-error';
    let title = 'Internal server error';
    let detail = 'The request could not be completed';
    let errors: unknown;
    if (error instanceof z.ZodError) {
      status = 400; type = 'https://queueforge.dev/problems/validation'; title = 'Request validation failed'; detail = 'One or more request fields are invalid'; errors = error.issues;
    } else if (error instanceof IdempotencyConflictError) {
      status = 409; type = 'https://queueforge.dev/problems/idempotency-conflict'; title = 'Idempotency key conflict'; detail = error.message; errors = { existing_job_id: error.existingJobId };
    } else if (error instanceof JobNotFoundError) {
      status = 404; type = 'https://queueforge.dev/problems/not-found'; title = 'Job not found'; detail = error.message;
    } else if (error instanceof InvalidTransitionError) {
      status = 409; type = 'https://queueforge.dev/problems/invalid-transition'; title = 'Invalid job transition'; detail = error.message;
    } else if (typeof error === 'object' && error !== null && 'statusCode' in error
      && typeof (error as { statusCode?: unknown }).statusCode === 'number'
      && (error as { statusCode: number }).statusCode < 500) {
      status = (error as { statusCode: number }).statusCode;
      type = 'https://queueforge.dev/problems/bad-request'; title = 'Bad request';
      detail = error instanceof Error ? error.message : 'The request was not valid';
    } else {
      logger.error('api_request_failed', { requestId: request.id, method: request.method, url: request.url, message: errorMessage(error) });
    }
    reply.status(status).type('application/problem+json').send({ type, title, status, detail, instance: request.url, request_id: request.id, ...(errors ? { errors } : {}) });
  });

  app.get('/', async () => ({
    name: 'QueueForge', version: '0.1.0', delivery: 'at-least-once',
    endpoints: { health: '/health/ready', jobs: '/v1/jobs', dashboard: '/v1/dashboard/summary', metrics: '/metrics' },
  }));
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try { await store.ping(); return { status: 'ready', database: 'connected' }; }
    catch { return reply.status(503).send({ status: 'not_ready', database: 'unavailable' }); }
  });

  app.post('/v1/jobs', async (request, reply) => {
    const parsed = submitSchema.parse(request.body);
    const availableAt = parsed.available_at ? new Date(parsed.available_at) : new Date();
    const key = idempotencyKey(request);
    const result = await store.submit({
      clientId: clientId(request), ...(key ? { idempotencyKey: key } : {}),
      queue: parsed.queue, type: parsed.type, payload: parsed.payload as JsonObject,
      priority: parsed.priority, availableAt,
      ...(parsed.available_at ? { availableAtFingerprint: new Date(parsed.available_at).toISOString() } : {}),
      maxAttempts: parsed.max_attempts, timeoutMs: parsed.timeout_ms,
      backoffBaseMs: parsed.backoff_base_ms, backoffCapMs: parsed.backoff_cap_ms,
    });
    reply.header('Location', `/v1/jobs/${result.job.id}`);
    reply.header('Idempotency-Replayed', String(result.replayed));
    return reply.status(result.replayed ? 200 : 202).send({ data: result.job, meta: { idempotency_replayed: result.replayed } });
  });

  app.get('/v1/jobs', async (request) => {
    const query = listSchema.parse(request.query);
    const before = decodeCursor(query.cursor);
    const result = await store.listJobs({
      ...(query.status ? { status: query.status } : {}),
      ...(query.queue ? { queue: query.queue } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(before ? { before } : {}),
      limit: query.limit,
    });
    const last = result.jobs.at(-1);
    return { data: result.jobs, meta: { next_cursor: result.hasMore && last ? encodeCursor(last) : null } };
  });

  app.get('/v1/jobs/:id', async (request) => {
    const { id } = uuidParam.parse(request.params);
    const [job, attempts, events] = await Promise.all([store.getJob(id), store.listAttempts(id), store.listEvents(id)]);
    if (!job) throw new JobNotFoundError('Job not found');
    return { data: { ...job, attempts, events } };
  });

  app.get('/v1/jobs/:id/events', async (request) => {
    const { id } = uuidParam.parse(request.params);
    const query = z.object({ after_id: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
    if (!await store.getJob(id)) throw new JobNotFoundError('Job not found');
    return { data: await store.listEvents(id, query.after_id, query.limit) };
  });

  app.post('/v1/jobs/:id/cancel', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const result = await store.cancel(id);
    return reply.status(result.outcome === 'requested' ? 202 : 200).send({ data: result.job, meta: { outcome: result.outcome } });
  });

  app.get('/v1/dead-letters', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    return { data: await store.listDeadLetters(query.limit) };
  });

  app.post('/v1/dead-letters/:jobId/redrive', async (request, reply) => {
    const { jobId } = deadParam.parse(request.params);
    const result = await store.redrive(jobId, clientId(request), idempotencyKey(request, true)!);
    reply.header('Location', `/v1/jobs/${result.job.id}`);
    return reply.status(result.replayed ? 200 : 202).send({ data: result.job, meta: { idempotency_replayed: result.replayed, redriven_from: jobId } });
  });

  app.get('/v1/workers', async () => ({ data: await store.listWorkers(config.workerOfflineMs) }));
  app.get('/v1/dashboard/summary', async () => ({ data: await store.dashboardSummary(config.workerOfflineMs) }));
  app.get('/v1/demo/effects/:id', async (request) => {
    const { id } = uuidParam.parse(request.params);
    return { data: await store.getDemoEffect(id) };
  });

  app.get('/v1/benchmarks/:runId', async (request) => {
    const { runId } = benchmarkParam.parse(request.params);
    return { data: await store.benchmarkSummary(runId) };
  });

  app.get('/v1/dashboard/events', async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'Access-Control-Allow-Origin': config.corsOrigin,
    });
    let sequence = 0;
    const send = async () => {
      try {
        const summary = await store.dashboardSummary(config.workerOfflineMs);
        response.write(`id: ${++sequence}\nevent: summary\ndata: ${JSON.stringify(summary)}\n\n`);
      } catch (error) {
        response.write(`event: error\ndata: ${JSON.stringify({ message: errorMessage(error) })}\n\n`);
      }
    };
    await send();
    const timer = setInterval(send, 2_000);
    request.raw.on('close', () => clearInterval(timer));
  });

  app.get('/metrics', async (_request, reply) => {
    const summary = await store.dashboardSummary(config.workerOfflineMs);
    metrics.ready.set(Number(summary.counts.ready));
    metrics.running.set(Number(summary.counts.running));
    metrics.dead.set(Number(summary.counts.dead_lettered));
    metrics.onlineWorkers.set(Number(summary.workers.online));
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  return app;
}
