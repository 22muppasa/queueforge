import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import type { ClaimedJob, JsonValue } from './domain.js';
import { PermanentJobError, RetryableJobError } from './domain.js';
import { createHandlers } from './handlers.js';
import type { Logger } from './logger.js';
import type { QueueStore } from './store.js';
import { errorMessage, sleep } from './util.js';

const cancelReason = new Error('Cancellation requested');
const timeoutReason = new Error('Job execution timed out');
const lostLeaseReason = new Error('Job lease was lost');

export class Worker {
  readonly id = randomUUID();
  private readonly handlers = createHandlers();
  private readonly active = new Map<string, Promise<void>>();
  private stopping = false;
  private stopped = false;

  constructor(
    private readonly store: QueueStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    await this.store.registerWorker({
      id: this.id,
      name: this.config.workerName,
      hostname: hostname(),
      pid: process.pid,
      queues: this.config.workerQueues,
      concurrency: this.config.workerConcurrency,
      buildVersion: this.config.buildVersion,
    });
    this.logger.info('worker_started', { workerId: this.id, name: this.config.workerName, concurrency: this.config.workerConcurrency, queues: this.config.workerQueues });

    await this.store.reapExpired().catch((error) => this.logger.warn('startup_reap_failed', { message: errorMessage(error) }));
    await Promise.all([this.claimLoop(), this.reaperLoop(), this.workerHeartbeatLoop()]);
  }

  async shutdown(graceMs = 15_000): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info('worker_draining', { workerId: this.id, active: this.active.size });
    await this.store.heartbeatWorker(this.id, this.active.size, 'draining').catch(() => undefined);
    const drain = Promise.allSettled([...this.active.values()]);
    await Promise.race([drain, sleep(graceMs)]);
    await this.store.stopWorker(this.id).catch(() => undefined);
    this.stopped = true;
    this.logger.info('worker_stopped', { workerId: this.id, remaining: this.active.size });
  }

  private async claimLoop(): Promise<void> {
    while (!this.stopped) {
      if (this.stopping) {
        await sleep(50);
        continue;
      }
      try {
        const free = this.config.workerConcurrency - this.active.size;
        if (free > 0) {
          const jobs = await this.store.claim(this.id, this.config.workerQueues, free, this.config.leaseMs);
          for (const job of jobs) {
            const execution = this.execute(job)
              .catch((error) => this.logger.error('job_supervisor_failed', {
                jobId: job.id,
                attempt: job.attempts_started,
                message: errorMessage(error),
              }))
              .finally(() => this.active.delete(job.id));
            this.active.set(job.id, execution);
          }
          if (jobs.length > 0) continue;
        }
      } catch (error) {
        this.logger.error('claim_failed', { message: errorMessage(error) });
        await sleep(Math.max(this.config.claimPollMs, 500));
      }
      await sleep(this.config.claimPollMs);
    }
  }

  private async reaperLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const recovered = await this.store.reapExpired();
        if (recovered > 0) this.logger.warn('expired_leases_recovered', { count: recovered });
      } catch (error) {
        this.logger.error('reaper_failed', { message: errorMessage(error) });
      }
      await sleep(this.config.reaperPollMs);
    }
  }

  private async workerHeartbeatLoop(): Promise<void> {
    while (!this.stopped) {
      await this.store.heartbeatWorker(this.id, this.active.size, this.stopping ? 'draining' : 'active')
        .catch((error) => this.logger.warn('worker_heartbeat_failed', { message: errorMessage(error) }));
      await sleep(Math.min(1_000, this.config.heartbeatMs));
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const log = this.logger;
    const handler = this.handlers.get(job.type);
    const controller = new AbortController();
    let ownershipLost = false;
    let cancellationRequested = false;
    let timedOut = false;
    let heartbeatBusy = false;

    const heartbeatTimer = setInterval(async () => {
      if (heartbeatBusy || controller.signal.aborted) return;
      heartbeatBusy = true;
      try {
        const heartbeat = await this.store.heartbeat(job, this.config.leaseMs);
        if (!heartbeat.owned) {
          ownershipLost = true;
          controller.abort(lostLeaseReason);
        } else if (heartbeat.cancelRequested) {
          cancellationRequested = true;
          controller.abort(cancelReason);
        }
      } catch (error) {
        log.warn('job_heartbeat_failed', { jobId: job.id, attempt: job.attempts_started, message: errorMessage(error) });
      } finally {
        heartbeatBusy = false;
      }
    }, this.config.heartbeatMs);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutReason);
    }, job.timeout_ms);

    log.info('job_started', { jobId: job.id, type: job.type, queue: job.queue, attempt: job.attempts_started, leaseGeneration: job.lease_generation });
    try {
      if (!handler) throw new PermanentJobError(`Unsupported job type: ${job.type}`);
      const result: JsonValue = await handler({ job, store: this.store, signal: controller.signal, logger: log });
      if (ownershipLost) return;
      const settled = await this.store.succeed(job, result);
      if (settled) log.info('job_succeeded', { jobId: job.id, attempt: job.attempts_started });
      else log.warn('job_settlement_rejected', { jobId: job.id, attempt: job.attempts_started, reason: 'stale_or_cancelled_lease' });
    } catch (error) {
      if (ownershipLost) {
        log.warn('job_abandoned_after_lease_loss', { jobId: job.id, attempt: job.attempts_started });
        return;
      }
      if (cancellationRequested || error === cancelReason) {
        const cancelled = await this.store.cancelOwned(job);
        log.info('job_cancelled', { jobId: job.id, attempt: job.attempts_started, settled: cancelled });
        return;
      }
      const kind = error instanceof PermanentJobError || error instanceof z.ZodError
        ? 'permanent_failure'
        : timedOut || error === timeoutReason
          ? 'timed_out'
          : 'retryable_failure';
      const name = error instanceof Error ? error.name : error instanceof RetryableJobError ? 'RetryableJobError' : 'UnknownError';
      const settled = await this.store.fail(job, kind, name, errorMessage(error));
      log.warn('job_failed', { jobId: job.id, attempt: job.attempts_started, kind, settled, message: errorMessage(error) });
    } finally {
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer);
    }
  }
}
