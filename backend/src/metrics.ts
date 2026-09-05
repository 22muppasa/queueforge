import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'queueforge_process_' });
  const httpRequests = new Counter({
    name: 'queueforge_http_requests_total',
    help: 'HTTP requests handled by the QueueForge API',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: 'queueforge_http_request_duration_seconds',
    help: 'QueueForge API request latency in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  const ready = new Gauge({ name: 'queueforge_jobs_ready', help: 'Jobs ready to be claimed', registers: [registry] });
  const running = new Gauge({ name: 'queueforge_jobs_running', help: 'Jobs with an active lease', registers: [registry] });
  const dead = new Gauge({ name: 'queueforge_jobs_dead_lettered', help: 'Jobs in the dead-letter queue', registers: [registry] });
  const onlineWorkers = new Gauge({ name: 'queueforge_workers_online', help: 'Workers with a recent heartbeat', registers: [registry] });
  return { registry, httpRequests, httpDuration, ready, running, dead, onlineWorkers };
}

export type Metrics = ReturnType<typeof createMetrics>;
