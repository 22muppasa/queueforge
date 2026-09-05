import { randomUUID } from 'node:crypto';
import type { DatabasePool, PoolClient } from './db.js';
import { transaction } from './db.js';
import type { ClaimedJob, Job, JsonObject, JsonValue, SubmitJob } from './domain.js';
import { fingerprint, fullJitterDelay, sha256 } from './util.js';

const PUBLIC_JOB_COLUMNS = `
  j.id, j.client_id, j.queue, j.type, j.payload, j.status, j.priority,
  j.available_at, j.attempts_started, j.max_attempts, j.timeout_ms,
  j.backoff_base_ms, j.backoff_cap_ms, j.lease_owner, w.name AS lease_owner_name,
  j.lease_generation, j.lease_expires_at, j.last_heartbeat_at,
  j.cancel_requested_at, j.first_started_at, j.finished_at, j.result,
  j.last_error, j.redrive_of_job_id, j.created_at, j.updated_at, j.revision
`;

type FailureKind = 'retryable_failure' | 'permanent_failure' | 'timed_out';

export class IdempotencyConflictError extends Error {
  override name = 'IdempotencyConflictError';
  constructor(public readonly existingJobId: string) {
    super('This idempotency key was already used with different job parameters');
  }
}

export class JobNotFoundError extends Error {
  override name = 'JobNotFoundError';
}

export class InvalidTransitionError extends Error {
  override name = 'InvalidTransitionError';
}

export interface WorkerRegistration {
  id: string;
  name: string;
  hostname: string;
  pid: number;
  queues: string[];
  concurrency: number;
  buildVersion: string;
}

export class QueueStore {
  constructor(private readonly pool: DatabasePool) {}

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async submit(input: SubmitJob): Promise<{ job: Job; replayed: boolean }> {
    const id = randomUUID();
    const semanticRequest = {
      queue: input.queue,
      type: input.type,
      payload: input.payload,
      priority: input.priority,
      availableAt: input.availableAtFingerprint ?? 'immediate',
      maxAttempts: input.maxAttempts,
      timeoutMs: input.timeoutMs,
      backoffBaseMs: input.backoffBaseMs,
      backoffCapMs: input.backoffCapMs,
      redriveOfJobId: input.redriveOfJobId ?? null,
    };
    const requestFingerprint = fingerprint(semanticRequest);

    return transaction(this.pool, async (client) => {
      if (input.idempotencyKey) {
        const keyHash = sha256(input.idempotencyKey);
        const reservation = await client.query<{ job_id: string }>(
          `INSERT INTO idempotency_records
             (client_id, operation, key_hash, request_fingerprint, job_id, expires_at)
           VALUES ($1, 'submit_job', $2, $3, $4, clock_timestamp() + interval '7 days')
           ON CONFLICT (client_id, operation, key_hash) DO NOTHING
           RETURNING job_id`,
          [input.clientId, keyHash, requestFingerprint, id],
        );
        if (reservation.rowCount === 0) {
          const existing = await client.query<{ job_id: string; request_fingerprint: string }>(
            `SELECT job_id, request_fingerprint FROM idempotency_records
             WHERE client_id = $1 AND operation = 'submit_job' AND key_hash = $2`,
            [input.clientId, keyHash],
          );
          const record = existing.rows[0];
          if (!record) throw new Error('Concurrent idempotency reservation disappeared');
          if (record.request_fingerprint.trim() !== requestFingerprint) {
            throw new IdempotencyConflictError(record.job_id);
          }
          const job = await this.getJobWithClient(client, record.job_id);
          if (!job) throw new Error('Idempotency record points to a missing job');
          return { job, replayed: true };
        }
      }

      await this.insertJob(client, id, input);
      const job = await this.getJobWithClient(client, id);
      if (!job) throw new Error('Inserted job could not be read back');
      return { job, replayed: false };
    });
  }

  private async insertJob(client: PoolClient, id: string, input: SubmitJob): Promise<void> {
    await client.query(
      `INSERT INTO jobs
        (id, client_id, queue, type, payload, status, priority, available_at,
         max_attempts, timeout_ms, backoff_base_ms, backoff_cap_ms, redrive_of_job_id)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10, $11, $12)`,
      [id, input.clientId, input.queue, input.type, input.payload, input.priority, input.availableAt,
        input.maxAttempts, input.timeoutMs, input.backoffBaseMs, input.backoffCapMs,
        input.redriveOfJobId ?? null],
    );
    await client.query(
      `INSERT INTO job_events(job_id, type, to_status, details)
       VALUES ($1, 'submitted', 'queued', jsonb_build_object('queue', $2::text, 'type', $3::text))`,
      [id, input.queue, input.type],
    );
    await client.query(`SELECT pg_notify('queueforge_jobs', $1)`, [input.queue]);
  }

  private async getJobWithClient(client: PoolClient, id: string): Promise<Job | null> {
    const result = await client.query<Job>(
      `SELECT ${PUBLIC_JOB_COLUMNS} FROM jobs j LEFT JOIN workers w ON w.id = j.lease_owner WHERE j.id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async getJob(id: string): Promise<Job | null> {
    const result = await this.pool.query<Job>(
      `SELECT ${PUBLIC_JOB_COLUMNS} FROM jobs j LEFT JOIN workers w ON w.id = j.lease_owner WHERE j.id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async listJobs(options: { status?: string; queue?: string; type?: string; limit: number; before?: { createdAt: string; id: string } }) {
    const values: unknown[] = [];
    const where: string[] = [];
    if (options.status) { values.push(options.status); where.push(`j.status = $${values.length}`); }
    if (options.queue) { values.push(options.queue); where.push(`j.queue = $${values.length}`); }
    if (options.type) { values.push(options.type); where.push(`j.type = $${values.length}`); }
    if (options.before) {
      values.push(options.before.createdAt, options.before.id);
      where.push(`(j.created_at, j.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(options.limit + 1);
    const result = await this.pool.query<Job>(
      `SELECT ${PUBLIC_JOB_COLUMNS} FROM jobs j LEFT JOIN workers w ON w.id = j.lease_owner
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY j.created_at DESC, j.id DESC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > options.limit;
    const jobs = hasMore ? result.rows.slice(0, options.limit) : result.rows;
    return { jobs, hasMore };
  }

  async listEvents(jobId: string, afterId = 0, limit = 200) {
    const result = await this.pool.query(
      `SELECT id, job_id, occurred_at, type, from_status, to_status, attempt_no, worker_id, details
       FROM job_events WHERE job_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
      [jobId, afterId, limit],
    );
    return result.rows;
  }

  async listAttempts(jobId: string) {
    const result = await this.pool.query(
      `SELECT a.job_id, a.attempt_no, a.lease_generation, a.worker_id, w.name AS worker_name,
              a.claimed_at, a.last_heartbeat_at, a.finished_at, a.outcome,
              a.error_type, a.error_message, a.next_available_at,
              a.raw_backoff_ms, a.backoff_ms, a.duration_ms
       FROM job_attempts a LEFT JOIN workers w ON w.id = a.worker_id
       WHERE a.job_id = $1 ORDER BY a.attempt_no`,
      [jobId],
    );
    return result.rows;
  }

  async claim(workerId: string, queues: string[], limit: number, leaseMs: number): Promise<ClaimedJob[]> {
    if (limit <= 0) return [];
    return transaction(this.pool, async (client) => {
      const candidates = await client.query<{ id: string }>(
        `SELECT id FROM jobs
         WHERE status IN ('queued', 'retry_wait')
           AND queue = ANY($1::text[])
           AND available_at <= clock_timestamp()
           AND cancel_requested_at IS NULL
           AND attempts_started < max_attempts
         ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [queues, limit],
      );
      const claimed: ClaimedJob[] = [];
      for (const candidate of candidates.rows) {
        const token = randomUUID();
        const updated = await client.query<ClaimedJob>(
          `UPDATE jobs SET
             status = 'running', attempts_started = attempts_started + 1,
             lease_owner = $2, lease_token = $3,
             lease_generation = lease_generation + 1,
             lease_expires_at = clock_timestamp() + $4::int * interval '1 millisecond',
             last_heartbeat_at = clock_timestamp(),
             first_started_at = COALESCE(first_started_at, clock_timestamp()),
             updated_at = clock_timestamp(), revision = revision + 1
           WHERE id = $1
           RETURNING *`,
          [candidate.id, workerId, token, leaseMs],
        );
        const job = updated.rows[0];
        if (!job) continue;
        await client.query(
          `INSERT INTO job_attempts(job_id, attempt_no, lease_token, lease_generation, worker_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [job.id, job.attempts_started, token, job.lease_generation, workerId],
        );
        await client.query(
          `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no, worker_id, details)
           VALUES ($1, 'claimed', NULL, 'running', $2, $3,
                   jsonb_build_object('lease_generation', $4::text, 'lease_ms', $5::int))`,
          [job.id, job.attempts_started, workerId, job.lease_generation, leaseMs],
        );
        job.lease_token = token;
        claimed.push(job);
      }
      return claimed;
    });
  }

  async heartbeat(job: ClaimedJob, leaseMs: number): Promise<{ owned: boolean; cancelRequested: boolean }> {
    const result = await this.pool.query<{ cancel_requested_at: string | null }>(
      `UPDATE jobs SET lease_expires_at = clock_timestamp() + $4::int * interval '1 millisecond',
                       last_heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'running' AND lease_token = $2
         AND lease_generation = $3 AND lease_expires_at > clock_timestamp()
       RETURNING cancel_requested_at`,
      [job.id, job.lease_token, job.lease_generation, leaseMs],
    );
    if (result.rowCount === 0) return { owned: false, cancelRequested: false };
    await this.pool.query(
      `UPDATE job_attempts SET last_heartbeat_at = clock_timestamp()
       WHERE job_id = $1 AND attempt_no = $2 AND lease_token = $3`,
      [job.id, job.attempts_started, job.lease_token],
    );
    return { owned: true, cancelRequested: Boolean(result.rows[0]?.cancel_requested_at) };
  }

  async succeed(job: ClaimedJob, result: JsonValue): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE jobs SET status = 'succeeded', result = $4, finished_at = clock_timestamp(),
                         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                         last_heartbeat_at = NULL, cancel_requested_at = NULL,
                         updated_at = clock_timestamp(), revision = revision + 1
         WHERE id = $1 AND status = 'running' AND lease_token = $2
           AND lease_generation = $3 AND lease_expires_at > clock_timestamp()
           AND cancel_requested_at IS NULL
         RETURNING id`,
        [job.id, job.lease_token, job.lease_generation, result],
      );
      if (updated.rowCount === 0) return false;
      await client.query(
        `UPDATE job_attempts SET finished_at = clock_timestamp(), outcome = 'succeeded',
           duration_ms = extract(epoch FROM (clock_timestamp() - claimed_at)) * 1000
         WHERE job_id = $1 AND attempt_no = $2 AND lease_token = $3`,
        [job.id, job.attempts_started, job.lease_token],
      );
      await client.query(
        `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no, worker_id)
         VALUES ($1, 'succeeded', 'running', 'succeeded', $2, $3)`,
        [job.id, job.attempts_started, job.lease_owner],
      );
      return true;
    });
  }

  async fail(job: ClaimedJob, kind: FailureKind, errorType: string, message: string): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<Job & { lease_token: string }>(
        `SELECT * FROM jobs WHERE id = $1 AND status = 'running' AND lease_token = $2
          AND lease_generation = $3 AND lease_expires_at > clock_timestamp() FOR UPDATE`,
        [job.id, job.lease_token, job.lease_generation],
      );
      const current = locked.rows[0];
      if (!current) return false;
      if (current.cancel_requested_at) {
        return this.cancelOwnedWithClient(client, job, 'cancelled');
      }

      const exhausted = current.attempts_started >= current.max_attempts;
      const isPermanent = kind === 'permanent_failure';
      const error = { type: errorType.slice(0, 128), message: message.slice(0, 2_000), retryable: !isPermanent };
      if (exhausted || isPermanent) {
        const reason = isPermanent ? 'non_retryable' : 'attempts_exhausted';
        await client.query(
          `UPDATE jobs SET status = 'dead_lettered', last_error = $4, finished_at = clock_timestamp(),
                           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                           last_heartbeat_at = NULL, cancel_requested_at = NULL,
                           updated_at = clock_timestamp(), revision = revision + 1
           WHERE id = $1 AND lease_token = $2 AND lease_generation = $3`,
          [job.id, job.lease_token, job.lease_generation, error],
        );
        await client.query(
          `UPDATE job_attempts SET finished_at = clock_timestamp(), outcome = $4,
             error_type = $5, error_message = $6,
             duration_ms = extract(epoch FROM (clock_timestamp() - claimed_at)) * 1000
           WHERE job_id = $1 AND attempt_no = $2 AND lease_token = $3`,
          [job.id, job.attempts_started, job.lease_token, kind, errorType.slice(0, 128), message.slice(0, 2_000)],
        );
        await client.query(
          `INSERT INTO dead_letters(job_id, reason, final_attempt, error_snapshot)
           VALUES ($1, $2, $3, $4) ON CONFLICT (job_id) DO NOTHING`,
          [job.id, reason, current.attempts_started, error],
        );
        await client.query(
          `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no, worker_id, details)
           VALUES ($1, 'dead_lettered', 'running', 'dead_lettered', $2, $3,
                   jsonb_build_object('reason', $4::text, 'error_type', $5::text))`,
          [job.id, job.attempts_started, job.lease_owner, reason, errorType.slice(0, 128)],
        );
        return true;
      }

      const { rawMs, delayMs } = fullJitterDelay(current.attempts_started, current.backoff_base_ms, current.backoff_cap_ms);
      await client.query(
        `UPDATE jobs SET status = 'retry_wait', last_error = $4,
                         available_at = clock_timestamp() + $5::int * interval '1 millisecond',
                         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                         last_heartbeat_at = NULL, cancel_requested_at = NULL,
                         updated_at = clock_timestamp(), revision = revision + 1
         WHERE id = $1 AND lease_token = $2 AND lease_generation = $3`,
        [job.id, job.lease_token, job.lease_generation, error, delayMs],
      );
      await client.query(
        `UPDATE job_attempts SET finished_at = clock_timestamp(), outcome = $4,
           error_type = $5, error_message = $6,
           next_available_at = clock_timestamp() + $7::int * interval '1 millisecond',
           raw_backoff_ms = $8, backoff_ms = $7,
           duration_ms = extract(epoch FROM (clock_timestamp() - claimed_at)) * 1000
         WHERE job_id = $1 AND attempt_no = $2 AND lease_token = $3`,
        [job.id, job.attempts_started, job.lease_token, kind, errorType.slice(0, 128), message.slice(0, 2_000), delayMs, rawMs],
      );
      await client.query(
        `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no, worker_id, details)
         VALUES ($1, 'retry_scheduled', 'running', 'retry_wait', $2, $3,
                 jsonb_build_object('error_type', $4::text, 'raw_backoff_ms', $5::int, 'backoff_ms', $6::int))`,
        [job.id, job.attempts_started, job.lease_owner, errorType.slice(0, 128), rawMs, delayMs],
      );
      return true;
    });
  }

  async cancel(id: string): Promise<{ job: Job; outcome: 'cancelled' | 'requested' | 'terminal' }> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<Job>(`SELECT * FROM jobs WHERE id = $1 FOR UPDATE`, [id]);
      const current = locked.rows[0];
      if (!current) throw new JobNotFoundError('Job not found');
      if (['succeeded', 'dead_lettered', 'cancelled'].includes(current.status)) {
        const job = await this.getJobWithClient(client, id);
        return { job: job!, outcome: 'terminal' };
      }
      if (current.status === 'running') {
        if (!current.cancel_requested_at) {
          await client.query(
            `UPDATE jobs SET cancel_requested_at = clock_timestamp(), updated_at = clock_timestamp(), revision = revision + 1 WHERE id = $1`,
            [id],
          );
          await client.query(
            `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no, worker_id)
             VALUES ($1, 'cancellation_requested', 'running', 'running', $2, $3)`,
            [id, current.attempts_started, current.lease_owner],
          );
        }
        const job = await this.getJobWithClient(client, id);
        return { job: job!, outcome: 'requested' };
      }
      await client.query(
        `UPDATE jobs SET status = 'cancelled', finished_at = clock_timestamp(), cancel_requested_at = NULL,
                         updated_at = clock_timestamp(), revision = revision + 1 WHERE id = $1`,
        [id],
      );
      await client.query(
        `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no)
         VALUES ($1, 'cancelled', $2, 'cancelled', $3)`,
        [id, current.status, current.attempts_started || null],
      );
      const job = await this.getJobWithClient(client, id);
      return { job: job!, outcome: 'cancelled' };
    });
  }

  async cancelOwned(job: ClaimedJob): Promise<boolean> {
    return transaction(this.pool, (client) => this.cancelOwnedWithClient(client, job, 'cancelled'));
  }

  private async cancelOwnedWithClient(client: PoolClient, job: ClaimedJob, outcome: 'cancelled'): Promise<boolean> {
    const updated = await client.query(
      `UPDATE jobs SET status = 'cancelled', finished_at = clock_timestamp(),
                       lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                       last_heartbeat_at = NULL, cancel_requested_at = NULL,
                       updated_at = clock_timestamp(), revision = revision + 1
       WHERE id = $1 AND status = 'running' AND lease_token = $2
         AND lease_generation = $3 AND lease_expires_at > clock_timestamp()
       RETURNING id`,
      [job.id, job.lease_token, job.lease_generation],
    );
    if (updated.rowCount === 0) return false;
    await client.query(
      `UPDATE job_attempts SET finished_at = clock_timestamp(), outcome = $4,
         duration_ms = extract(epoch FROM (clock_timestamp() - claimed_at)) * 1000
       WHERE job_id = $1 AND attempt_no = $2 AND lease_token = $3`,
      [job.id, job.attempts_started, job.lease_token, outcome],
    );
    await client.query(
      `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no, worker_id)
       VALUES ($1, 'cancelled', 'running', 'cancelled', $2, $3)`,
      [job.id, job.attempts_started, job.lease_owner],
    );
    return true;
  }

  async reapExpired(limit = 50): Promise<number> {
    return transaction(this.pool, async (client) => {
      const expired = await client.query<Job & { lease_token: string }>(
        `SELECT * FROM jobs WHERE status = 'running' AND lease_expires_at <= clock_timestamp()
         ORDER BY lease_expires_at, id FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      for (const current of expired.rows) {
        const attempt = current.attempts_started;
        const common = [current.id, attempt, current.lease_token];
        await client.query(
          `UPDATE job_attempts SET finished_at = clock_timestamp(), outcome = 'lease_expired',
             error_type = 'LeaseExpired', error_message = 'Worker stopped heartbeating before the lease deadline',
             duration_ms = extract(epoch FROM (clock_timestamp() - claimed_at)) * 1000
           WHERE job_id = $1 AND attempt_no = $2 AND lease_token = $3 AND outcome IS NULL`,
          common,
        );
        await client.query(
          `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no, worker_id, details)
           VALUES ($1, 'lease_expired', 'running', NULL, $2, $3,
                   jsonb_build_object('lease_generation', $4::text))`,
          [current.id, attempt, current.lease_owner, current.lease_generation],
        );

        if (current.cancel_requested_at) {
          await client.query(
            `UPDATE jobs SET status = 'cancelled', finished_at = clock_timestamp(),
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
               cancel_requested_at = NULL, updated_at = clock_timestamp(), revision = revision + 1
             WHERE id = $1 AND status = 'running' AND lease_token = $2`,
            [current.id, current.lease_token],
          );
          await client.query(
            `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no, worker_id, details)
             VALUES ($1, 'cancelled', 'running', 'cancelled', $2, $3, '{"reason":"lease_expired_after_cancel"}')`,
            [current.id, attempt, current.lease_owner],
          );
          continue;
        }

        const error: JsonObject = { type: 'LeaseExpired', message: 'Worker stopped heartbeating before the lease deadline', retryable: true };
        if (attempt >= current.max_attempts) {
          await client.query(
            `UPDATE jobs SET status = 'dead_lettered', last_error = $3, finished_at = clock_timestamp(),
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
               cancel_requested_at = NULL, updated_at = clock_timestamp(), revision = revision + 1
             WHERE id = $1 AND status = 'running' AND lease_token = $2`,
            [current.id, current.lease_token, error],
          );
          await client.query(
            `INSERT INTO dead_letters(job_id, reason, final_attempt, error_snapshot)
             VALUES ($1, 'attempts_exhausted', $2, $3) ON CONFLICT (job_id) DO NOTHING`,
            [current.id, attempt, error],
          );
          await client.query(
            `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no, worker_id, details)
             VALUES ($1, 'dead_lettered', 'running', 'dead_lettered', $2, $3, '{"reason":"attempts_exhausted"}')`,
            [current.id, attempt, current.lease_owner],
          );
          continue;
        }

        const { rawMs, delayMs } = fullJitterDelay(attempt, current.backoff_base_ms, current.backoff_cap_ms);
        await client.query(
          `UPDATE jobs SET status = 'retry_wait', last_error = $3,
             available_at = clock_timestamp() + $4::int * interval '1 millisecond',
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
             cancel_requested_at = NULL, updated_at = clock_timestamp(), revision = revision + 1
           WHERE id = $1 AND status = 'running' AND lease_token = $2`,
          [current.id, current.lease_token, error, delayMs],
        );
        await client.query(
          `UPDATE job_attempts SET next_available_at = clock_timestamp() + $4::int * interval '1 millisecond',
             raw_backoff_ms = $5, backoff_ms = $4
           WHERE job_id = $1 AND attempt_no = $2 AND lease_token = $3`,
          [current.id, attempt, current.lease_token, delayMs, rawMs],
        );
        await client.query(
          `INSERT INTO job_events(job_id, type, from_status, to_status, attempt_no, worker_id, details)
           VALUES ($1, 'retry_scheduled', 'running', 'retry_wait', $2, $3,
                   jsonb_build_object('reason', 'lease_expired', 'raw_backoff_ms', $4::int, 'backoff_ms', $5::int))`,
          [current.id, attempt, current.lease_owner, rawMs, delayMs],
        );
      }
      return expired.rows.length;
    });
  }

  async registerWorker(worker: WorkerRegistration): Promise<void> {
    await this.pool.query(
      `INSERT INTO workers(id, name, hostname, pid, queues, concurrency, status, build_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
       ON CONFLICT (id) DO UPDATE SET status = 'active', last_seen_at = clock_timestamp()`,
      [worker.id, worker.name, worker.hostname, worker.pid, worker.queues, worker.concurrency, worker.buildVersion],
    );
  }

  async heartbeatWorker(id: string, currentJobs: number, status: 'active' | 'draining' = 'active'): Promise<void> {
    await this.pool.query(
      `UPDATE workers SET current_jobs = $2, status = $3, last_seen_at = clock_timestamp() WHERE id = $1`,
      [id, currentJobs, status],
    );
  }

  async stopWorker(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE workers SET current_jobs = 0, status = 'stopped', last_seen_at = clock_timestamp() WHERE id = $1`,
      [id],
    );
  }

  async listWorkers(offlineMs: number) {
    const result = await this.pool.query(
      `SELECT id, name, hostname, pid, queues, concurrency, current_jobs, build_version,
              started_at, last_seen_at,
              CASE WHEN last_seen_at < clock_timestamp() - $1::int * interval '1 millisecond'
                   THEN 'offline' ELSE status END AS status,
              extract(epoch FROM (clock_timestamp() - last_seen_at)) * 1000 AS heartbeat_age_ms
       FROM workers ORDER BY last_seen_at DESC`,
      [offlineMs],
    );
    return result.rows;
  }

  async listDeadLetters(limit = 100) {
    const result = await this.pool.query(
      `SELECT d.job_id, d.reason, d.final_attempt, d.error_snapshot, d.dead_lettered_at,
              j.queue, j.type, j.payload, j.created_at
       FROM dead_letters d JOIN jobs j ON j.id = d.job_id
       ORDER BY d.dead_lettered_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async redrive(sourceJobId: string, clientId: string, idempotencyKey: string) {
    const source = await this.getJob(sourceJobId);
    if (!source) throw new JobNotFoundError('Dead-lettered job not found');
    if (source.status !== 'dead_lettered') throw new InvalidTransitionError('Only dead-lettered jobs can be redriven');
    const result = await this.submit({
      clientId,
      idempotencyKey: `redrive:${sourceJobId}:${idempotencyKey}`,
      queue: source.queue,
      type: source.type,
      payload: source.payload,
      priority: source.priority,
      availableAt: new Date(),
      maxAttempts: source.max_attempts,
      timeoutMs: source.timeout_ms,
      backoffBaseMs: source.backoff_base_ms,
      backoffCapMs: source.backoff_cap_ms,
      redriveOfJobId: sourceJobId,
    });
    await transaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO job_redrives(source_job_id, destination_job_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING destination_job_id`,
        [sourceJobId, result.job.id],
      );
      if (inserted.rowCount) {
        await client.query(
          `INSERT INTO job_events(job_id, type, from_status, to_status, details)
           VALUES ($1, 'redriven', 'dead_lettered', 'dead_lettered', jsonb_build_object('destination_job_id', $2::text))`,
          [sourceJobId, result.job.id],
        );
      }
    });
    return result;
  }

  async applyDemoEffect(job: ClaimedJob, effectKey: string, value: number): Promise<{ applied: boolean }> {
    return transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO demo_attempt_visits(job_id, attempt_no, worker_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [job.id, job.attempts_started, job.lease_owner],
      );
      const inserted = await client.query(
        `INSERT INTO demo_effects(job_id, effect_key, value, first_attempt, first_worker_id)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id) DO NOTHING RETURNING job_id`,
        [job.id, effectKey.slice(0, 128), value, job.attempts_started, job.lease_owner],
      );
      return { applied: Boolean(inserted.rowCount) };
    });
  }

  async getDemoEffect(jobId: string) {
    const [effect, visits] = await Promise.all([
      this.pool.query(`SELECT * FROM demo_effects WHERE job_id = $1`, [jobId]),
      this.pool.query(
        `SELECT v.job_id, v.attempt_no, v.worker_id, w.name AS worker_name, v.visited_at
         FROM demo_attempt_visits v LEFT JOIN workers w ON w.id = v.worker_id
         WHERE v.job_id = $1 ORDER BY v.attempt_no`,
        [jobId],
      ),
    ]);
    return { effect: effect.rows[0] ?? null, visits: visits.rows, logicalEffectCount: effect.rowCount ?? 0 };
  }

  async benchmarkSummary(runId: string) {
    const result = await this.pool.query(
      `WITH selected AS (
         SELECT * FROM jobs WHERE client_id = $1
       ), job_stats AS (
         SELECT
           count(*)::int AS accepted,
           count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
           count(*) FILTER (WHERE status = 'dead_lettered')::int AS dead_lettered,
           count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
           count(*) FILTER (WHERE status NOT IN ('succeeded','dead_lettered','cancelled'))::int AS unfinished,
           min(created_at) AS first_created_at,
           max(created_at) AS last_created_at,
           max(finished_at) AS last_finished_at,
           COALESCE(extract(epoch FROM (max(finished_at) - min(created_at))), 0)::float8 AS drain_window_seconds,
           CASE WHEN extract(epoch FROM (max(finished_at) - min(created_at))) > 0
                THEN count(*) FILTER (WHERE status = 'succeeded')::float8 /
                     extract(epoch FROM (max(finished_at) - min(created_at)))
                ELSE 0 END AS completed_per_second,
           COALESCE(percentile_cont(0.5) WITHIN GROUP
             (ORDER BY extract(epoch FROM (first_started_at - created_at)) * 1000)
             FILTER (WHERE first_started_at IS NOT NULL), 0)::float8 AS queue_wait_p50_ms,
           COALESCE(percentile_cont(0.95) WITHIN GROUP
             (ORDER BY extract(epoch FROM (first_started_at - created_at)) * 1000)
             FILTER (WHERE first_started_at IS NOT NULL), 0)::float8 AS queue_wait_p95_ms,
           COALESCE(percentile_cont(0.99) WITHIN GROUP
             (ORDER BY extract(epoch FROM (first_started_at - created_at)) * 1000)
             FILTER (WHERE first_started_at IS NOT NULL), 0)::float8 AS queue_wait_p99_ms,
           COALESCE(percentile_cont(0.5) WITHIN GROUP
             (ORDER BY extract(epoch FROM (finished_at - created_at)) * 1000)
             FILTER (WHERE finished_at IS NOT NULL), 0)::float8 AS end_to_end_p50_ms,
           COALESCE(percentile_cont(0.95) WITHIN GROUP
             (ORDER BY extract(epoch FROM (finished_at - created_at)) * 1000)
             FILTER (WHERE finished_at IS NOT NULL), 0)::float8 AS end_to_end_p95_ms,
           COALESCE(percentile_cont(0.99) WITHIN GROUP
             (ORDER BY extract(epoch FROM (finished_at - created_at)) * 1000)
             FILTER (WHERE finished_at IS NOT NULL), 0)::float8 AS end_to_end_p99_ms
         FROM selected
       ), attempt_stats AS (
         SELECT
           count(*)::int AS attempts,
           count(*) FILTER (WHERE outcome = 'lease_expired')::int AS lease_expirations,
           COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE duration_ms IS NOT NULL), 0)::float8 AS execution_p50_ms,
           COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE duration_ms IS NOT NULL), 0)::float8 AS execution_p95_ms,
           COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE duration_ms IS NOT NULL), 0)::float8 AS execution_p99_ms
         FROM job_attempts a JOIN selected s ON s.id = a.job_id
       ), event_stats AS (
         SELECT
           count(*) FILTER (WHERE e.type = 'submitted')::int AS submitted_events,
           count(*) FILTER (WHERE e.type = 'claimed')::int AS claimed_events,
           count(*) FILTER (WHERE e.type = 'succeeded')::int AS succeeded_events,
           count(*) FILTER (WHERE e.type = 'retry_scheduled')::int AS retry_events,
           count(*) FILTER (WHERE e.type = 'lease_expired')::int AS lease_expired_events,
           count(*) FILTER (WHERE e.type = 'dead_lettered')::int AS dead_lettered_events
         FROM job_events e JOIN selected s ON s.id = e.job_id
       ), idempotency_stats AS (
         SELECT count(*)::int AS idempotency_records,
                count(DISTINCT i.job_id)::int AS idempotency_job_ids
         FROM idempotency_records i JOIN selected s ON s.id = i.job_id
       )
       SELECT j.*,
         a.attempts, a.lease_expirations,
         a.execution_p50_ms, a.execution_p95_ms, a.execution_p99_ms,
         e.submitted_events, e.claimed_events, e.succeeded_events,
         e.retry_events, e.lease_expired_events, e.dead_lettered_events,
         i.idempotency_records, i.idempotency_job_ids
       FROM job_stats j CROSS JOIN attempt_stats a CROSS JOIN event_stats e CROSS JOIN idempotency_stats i`,
      [runId],
    );
    return { run_id: runId, ...result.rows[0] };
  }

  async dashboardSummary(offlineMs: number) {
    const [counts, rates, latency, workers, timeline] = await Promise.all([
      this.pool.query(
        `SELECT
           count(*) FILTER (WHERE status IN ('queued','retry_wait') AND available_at <= clock_timestamp())::int AS ready,
           count(*) FILTER (WHERE status IN ('queued','retry_wait') AND available_at > clock_timestamp())::int AS scheduled,
           count(*) FILTER (WHERE status = 'running')::int AS running,
           count(*) FILTER (WHERE status = 'retry_wait')::int AS retry_wait,
           count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
           count(*) FILTER (WHERE status = 'dead_lettered')::int AS dead_lettered,
           count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
           COALESCE(max(extract(epoch FROM (clock_timestamp() - available_at))) FILTER
             (WHERE status IN ('queued','retry_wait') AND available_at <= clock_timestamp()), 0) * 1000 AS oldest_ready_age_ms
         FROM jobs`,
      ),
      this.pool.query(
        `SELECT
           count(*) FILTER (WHERE type = 'succeeded' AND occurred_at >= clock_timestamp() - interval '1 minute')::float / 60 AS completed_per_second,
           count(*) FILTER (WHERE type = 'retry_scheduled' AND occurred_at >= clock_timestamp() - interval '5 minutes')::int AS retries_5m,
           count(*) FILTER (WHERE type = 'lease_expired' AND occurred_at >= clock_timestamp() - interval '5 minutes')::int AS leases_expired_5m,
           count(*) FILTER (WHERE type = 'dead_lettered' AND occurred_at >= clock_timestamp() - interval '5 minutes')::int AS dead_letters_5m
         FROM job_events`,
      ),
      this.pool.query(
        `SELECT
           COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_started_at-created_at))*1000) FILTER (WHERE first_started_at IS NOT NULL), 0) AS queue_wait_p50_ms,
           COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (first_started_at-created_at))*1000) FILTER (WHERE first_started_at IS NOT NULL), 0) AS queue_wait_p95_ms,
           COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (first_started_at-created_at))*1000) FILTER (WHERE first_started_at IS NOT NULL), 0) AS queue_wait_p99_ms,
           COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at-created_at))*1000) FILTER (WHERE finished_at IS NOT NULL), 0) AS end_to_end_p50_ms,
           COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at-created_at))*1000) FILTER (WHERE finished_at IS NOT NULL), 0) AS end_to_end_p95_ms,
           COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at-created_at))*1000) FILTER (WHERE finished_at IS NOT NULL), 0) AS end_to_end_p99_ms
         FROM jobs WHERE created_at >= clock_timestamp() - interval '15 minutes'`,
      ),
      this.pool.query(
        `SELECT count(*) FILTER (WHERE last_seen_at >= clock_timestamp() - $1::int * interval '1 millisecond' AND status <> 'stopped')::int AS online,
                COALESCE(sum(current_jobs) FILTER (WHERE last_seen_at >= clock_timestamp() - $1::int * interval '1 millisecond'), 0)::int AS busy
         FROM workers`,
        [offlineMs],
      ),
      this.pool.query(
        `WITH buckets AS (
           SELECT generate_series(date_trunc('minute', clock_timestamp()) - interval '14 minutes', date_trunc('minute', clock_timestamp()), interval '1 minute') AS minute
         ), events AS (
           SELECT date_trunc('minute', occurred_at) AS minute,
                  count(*) FILTER (WHERE type = 'succeeded')::int AS completed,
                  count(*) FILTER (WHERE type = 'dead_lettered')::int AS failed
           FROM job_events WHERE occurred_at >= clock_timestamp() - interval '15 minutes'
           GROUP BY 1
         )
         SELECT b.minute, COALESCE(e.completed, 0) AS completed, COALESCE(e.failed, 0) AS failed
         FROM buckets b LEFT JOIN events e USING (minute) ORDER BY b.minute`,
      ),
    ]);
    return {
      serverTime: new Date().toISOString(),
      counts: counts.rows[0],
      rates: rates.rows[0],
      latency: latency.rows[0],
      workers: workers.rows[0],
      timeline: timeline.rows,
    };
  }
}
