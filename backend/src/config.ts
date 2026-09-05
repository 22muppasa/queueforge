import { z } from 'zod';

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const envSchema = z.object({
  DATABASE_URL: z.string().url().default('postgresql://queueforge:queueforge-local-only@localhost:54329/queueforge'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: integer(8080, 1, 65535),
  WORKER_NAME: z.string().min(1).max(64).default('worker-local'),
  WORKER_QUEUES: z.string().default('default,critical,media'),
  WORKER_CONCURRENCY: integer(4, 1, 64),
  LEASE_MS: integer(6_000, 1_000, 3_600_000),
  HEARTBEAT_MS: integer(1_800, 100, 1_200_000),
  CLAIM_POLL_MS: integer(100, 10, 60_000),
  REAPER_POLL_MS: integer(250, 10, 60_000),
  WORKER_OFFLINE_MS: integer(5_000, 1_000, 300_000),
  DATABASE_POOL_SIZE: integer(12, 2, 100),
  BUILD_VERSION: z.string().max(128).default('dev'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ORIGIN: z.string().default('*'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(source);
  if (parsed.HEARTBEAT_MS >= parsed.LEASE_MS) {
    throw new Error('HEARTBEAT_MS must be smaller than LEASE_MS');
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    apiHost: parsed.API_HOST,
    apiPort: parsed.API_PORT,
    workerName: parsed.WORKER_NAME,
    workerQueues: [...new Set(parsed.WORKER_QUEUES.split(',').map((item) => item.trim()).filter(Boolean))],
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    leaseMs: parsed.LEASE_MS,
    heartbeatMs: parsed.HEARTBEAT_MS,
    claimPollMs: parsed.CLAIM_POLL_MS,
    reaperPollMs: parsed.REAPER_POLL_MS,
    workerOfflineMs: parsed.WORKER_OFFLINE_MS,
    databasePoolSize: parsed.DATABASE_POOL_SIZE,
    buildVersion: parsed.BUILD_VERSION,
    logLevel: parsed.LOG_LEVEL,
    corsOrigin: parsed.CORS_ORIGIN,
  };
}
