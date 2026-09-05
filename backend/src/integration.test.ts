import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, migrate, type DatabasePool } from './db.js';
import type { SubmitJob } from './domain.js';
import { IdempotencyConflictError, QueueStore } from './store.js';

const connectionString = process.env.TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration('QueueStore with PostgreSQL', () => {
  let pool: DatabasePool;
  let store: QueueStore;

  const input = (overrides: Partial<SubmitJob> = {}): SubmitJob => ({
    clientId: 'integration', queue: 'default', type: 'noop', payload: {}, priority: 0,
    availableAt: new Date(), maxAttempts: 3, timeoutMs: 10_000,
    backoffBaseMs: 1, backoffCapMs: 10,
    ...overrides,
  });

  beforeAll(async () => {
    pool = createPool(connectionString!, 30);
    await migrate(pool);
    store = new QueueStore(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE job_redrives, demo_attempt_visits, demo_effects, dead_letters, job_events, job_attempts, idempotency_records, jobs, workers CASCADE');
  });

  afterAll(async () => pool?.end());

  it('deduplicates concurrent identical submissions and rejects key reuse with different intent', async () => {
    const submissions = await Promise.all(Array.from({ length: 20 }, () => store.submit(input({ idempotencyKey: 'same-key' }))));
    expect(new Set(submissions.map((item) => item.job.id)).size).toBe(1);
    expect(submissions.filter((item) => !item.replayed)).toHaveLength(1);
    await expect(store.submit(input({ idempotencyKey: 'same-key', payload: { changed: true } }))).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('lets concurrent consumers claim each ready job at most once per generation', async () => {
    await Promise.all(Array.from({ length: 100 }, (_, index) => store.submit(input({ payload: { index } }))));
    const workerIds = Array.from({ length: 10 }, () => randomUUID());
    const batches = await Promise.all(workerIds.map((workerId) => store.claim(workerId, ['default'], 20, 10_000)));
    const claimed = batches.flat();
    expect(claimed).toHaveLength(100);
    expect(new Set(claimed.map((job) => job.id)).size).toBe(100);
    const openAttempts = await pool.query('SELECT count(*)::int AS count FROM job_attempts WHERE outcome IS NULL');
    expect(openAttempts.rows[0].count).toBe(100);
  });

  it('fences stale workers after lease expiry and permits the replacement to settle', async () => {
    const submitted = await store.submit(input());
    const workerA = randomUUID();
    const workerB = randomUUID();
    const first = (await store.claim(workerA, ['default'], 1, 5_000))[0]!;
    await pool.query(`UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE id = $1`, [submitted.job.id]);
    expect(await store.reapExpired()).toBe(1);
    await pool.query(`UPDATE jobs SET available_at = clock_timestamp() WHERE id = $1`, [submitted.job.id]);
    const second = (await store.claim(workerB, ['default'], 1, 5_000))[0]!;
    expect(second.lease_generation).not.toBe(first.lease_generation);
    expect(await store.succeed(first, { stale: true })).toBe(false);
    expect(await store.succeed(second, { winner: true })).toBe(true);
    const job = await store.getJob(submitted.job.id);
    expect(job?.status).toBe('succeeded');
    expect(job?.result).toEqual({ winner: true });
  });

  it('moves a poison job to the DLQ after bounded attempts', async () => {
    const submitted = await store.submit(input({ maxAttempts: 2 }));
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await pool.query(`UPDATE jobs SET available_at = clock_timestamp() WHERE id = $1`, [submitted.job.id]);
      const job = (await store.claim(randomUUID(), ['default'], 1, 5_000))[0]!;
      expect(await store.fail(job, 'retryable_failure', 'PlannedFailure', 'expected')).toBe(true);
    }
    expect((await store.getJob(submitted.job.id))?.status).toBe('dead_lettered');
    expect(await store.listDeadLetters()).toHaveLength(1);
    const attempts = await store.listAttempts(submitted.job.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].outcome).toBe('retryable_failure');
  });

  it('cancels ready jobs immediately and running jobs cooperatively', async () => {
    const ready = await store.submit(input());
    expect((await store.cancel(ready.job.id)).outcome).toBe('cancelled');
    const running = await store.submit(input());
    const claimed = (await store.claim(randomUUID(), ['default'], 1, 5_000))[0]!;
    expect((await store.cancel(running.job.id)).outcome).toBe('requested');
    expect((await store.heartbeat(claimed, 5_000)).cancelRequested).toBe(true);
    expect(await store.cancelOwned(claimed)).toBe(true);
    expect((await store.getJob(running.job.id))?.status).toBe('cancelled');
  });
});
