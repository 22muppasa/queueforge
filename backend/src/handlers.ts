import { z } from 'zod';
import type { ClaimedJob, JsonValue } from './domain.js';
import { PermanentJobError, RetryableJobError } from './domain.js';
import type { Logger } from './logger.js';
import type { QueueStore } from './store.js';
import { sleep } from './util.js';

export interface HandlerContext {
  job: ClaimedJob;
  store: QueueStore;
  signal: AbortSignal;
  logger: Logger;
}

export type Handler = (context: HandlerContext) => Promise<JsonValue>;

const sleepPayload = z.object({ duration_ms: z.number().int().min(0).max(300_000).default(0) }).strict();
const flakyPayload = z.object({
  fail_until_attempt: z.number().int().min(0).max(99).default(1),
  duration_ms: z.number().int().min(0).max(300_000).default(0),
}).strict();
const failurePayload = z.object({
  message: z.string().max(500).default('Intentional failure'),
  retryable: z.boolean().default(true),
  duration_ms: z.number().int().min(0).max(300_000).default(0),
}).strict();
const counterPayload = z.object({
  effect_key: z.string().min(1).max(128).default('demo-counter'),
  value: z.number().int().min(-1_000_000).max(1_000_000).default(1),
  sleep_before_effect_ms: z.number().int().min(0).max(300_000).default(0),
  sleep_after_effect_ms: z.number().int().min(0).max(300_000).default(0),
}).strict();

export function createHandlers(): ReadonlyMap<string, Handler> {
  return new Map<string, Handler>([
    ['noop', async ({ job, signal }) => {
      const payload = sleepPayload.parse(job.payload);
      await sleep(payload.duration_ms, signal);
      return { ok: true, duration_ms: payload.duration_ms, attempt: job.attempts_started };
    }],
    ['flaky', async ({ job, signal }) => {
      const payload = flakyPayload.parse(job.payload);
      await sleep(payload.duration_ms, signal);
      if (job.attempts_started <= payload.fail_until_attempt) {
        throw new RetryableJobError(`Planned transient failure on attempt ${job.attempts_started}`);
      }
      return { ok: true, recovered_on_attempt: job.attempts_started };
    }],
    ['always_fail', async ({ job, signal }) => {
      const payload = failurePayload.parse(job.payload);
      await sleep(payload.duration_ms, signal);
      if (payload.retryable) throw new RetryableJobError(payload.message);
      throw new PermanentJobError(payload.message);
    }],
    ['idempotent_counter', async ({ job, store, signal, logger }) => {
      const payload = counterPayload.parse(job.payload);
      await sleep(payload.sleep_before_effect_ms, signal);
      const effect = await store.applyDemoEffect(job, payload.effect_key, payload.value);
      logger.info('demo_effect_observed', { jobId: job.id, attempt: job.attempts_started, applied: effect.applied });
      await sleep(payload.sleep_after_effect_ms, signal);
      return { ok: true, logical_effect_applied_by_this_attempt: effect.applied, attempt: job.attempts_started };
    }],
  ]);
}
