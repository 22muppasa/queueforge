import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

const rate = Number(__ENV.RATE || 50);
const duration = __ENV.DURATION || '10s';
const runId = __ENV.RUN_ID || `manual-${Date.now()}`;
const baseUrl = __ENV.BASE_URL || 'http://api:8080';
const handlerMs = Number(__ENV.HANDLER_MS || 0);
const jobsAccepted = new Counter('jobs_accepted');
const replayedResponses = new Counter('idempotency_replays');

export const options = {
  scenarios: {
    submissions: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: Math.max(50, rate),
      maxVUs: Math.max(50, rate),
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  discardResponseBodies: false,
};

export default function submitJob() {
  const iteration = exec.scenario.iterationInTest;
  const response = http.post(`${baseUrl}/v1/jobs`, JSON.stringify({
    queue: 'default',
    type: 'noop',
    payload: { duration_ms: handlerMs },
    max_attempts: 1,
    timeout_ms: 30_000,
    backoff_base_ms: 100,
    backoff_cap_ms: 1_000,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `${runId}-${iteration}`,
      'X-Client-Id': runId,
    },
    tags: { endpoint: 'submit_job' },
  });
  let parsed = null;
  try { parsed = response.json(); } catch { /* counted by checks */ }
  const replayed = response.headers['Idempotency-Replayed'] === 'true';
  if (replayed) replayedResponses.add(1);
  const accepted = check(response, {
    'HTTP 202 accepted': (value) => value.status === 202,
    'response has a job UUID': () => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed?.data?.id ?? ''),
    'Location names the accepted job': (value) => value.headers.Location === `/v1/jobs/${parsed?.data?.id}`,
    'submission was not replayed': () => !replayed && parsed?.meta?.idempotency_replayed === false,
  });
  if (accepted) jobsAccepted.add(1);
}

export function handleSummary(data) {
  return { [`/results/${runId}-k6-summary.json`]: JSON.stringify(data, null, 2) };
}
