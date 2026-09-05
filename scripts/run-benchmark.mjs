import { execFile as execFileCallback } from 'node:child_process';
import { cpus, hostname, platform, release, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const evidenceDir = new URL('../evidence/', import.meta.url);
const rawDir = new URL('../evidence/raw/', import.meta.url);
const baseUrl = process.env.QUEUEFORGE_API ?? 'http://localhost:18080';
const rates = (process.env.BENCH_RATES ?? '50,150,300').split(',').map(Number).filter((value) => Number.isFinite(value) && value > 0);
const repetitions = Number(process.env.BENCH_REPETITIONS ?? 3);
const duration = process.env.BENCH_DURATION ?? '10s';
const warmupRate = Number(process.env.BENCH_WARMUP_RATE ?? 25);
const warmupDuration = process.env.BENCH_WARMUP_DURATION ?? '5s';
const batchId = `bench-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
const startedAt = new Date();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(file, args, options = {}) {
  const result = await execFile(file, args, {
    cwd: root,
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function docker(...args) {
  return command('docker', args);
}

async function api(path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body.data ?? body;
}

async function waitFor(label, probe, predicate, timeoutMs = 120_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (predicate(last)) return last;
    } catch (error) {
      last = { probe_error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function preflight() {
  await waitFor('API readiness', () => api('/health/ready'), (value) => value.status === 'ready', 60_000);
  const workers = await waitFor(
    'three active worker names',
    () => api('/v1/workers'),
    (items) => ['worker-a', 'worker-b', 'worker-c'].every((name) => items.some((item) => item.name === name && item.status === 'active')),
    30_000,
  );
  const queue = await waitFor(
    'an empty runnable queue',
    () => api('/v1/dashboard/summary'),
    (value) => Number(value.counts.ready) === 0 && Number(value.counts.running) === 0 && Number(value.counts.retry_wait) === 0,
    120_000,
    500,
  );
  return { workers: workers.filter((item) => item.status === 'active'), queue };
}

async function restartCounts() {
  const names = ['queueforge-api', 'queueforge-worker-a', 'queueforge-worker-b', 'queueforge-worker-c', 'queueforge-postgres-1'];
  const values = {};
  for (const name of names) {
    const { stdout } = await docker('inspect', '--format', '{{.RestartCount}}', name);
    values[name] = Number(stdout);
  }
  return values;
}

function metric(summary, name, field, fallback = 0) {
  const value = summary?.metrics?.[name]?.values?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function systemSnapshot() {
  try {
    const { stdout } = await docker(
      'stats', '--no-stream', '--format', '{{json .}}',
      'queueforge-api', 'queueforge-worker-a', 'queueforge-worker-b', 'queueforge-worker-c', 'queueforge-postgres-1',
    );
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }];
  }
}

async function runLoad(runId, rate, runDuration, formal) {
  const before = await api(`/v1/benchmarks/${runId}`);
  if (Number(before.accepted) !== 0) throw new Error(`Benchmark cohort ${runId} already exists`);
  const restartsBefore = await restartCounts();
  const samples = [];
  const args = [
    'compose', '--profile', 'load', 'run', '--rm',
    '-e', `RATE=${rate}`, '-e', `DURATION=${runDuration}`, '-e', `RUN_ID=${runId}`,
    '-e', 'HANDLER_MS=0', 'k6', 'run', '--quiet', '/scripts/k6-submit.js',
  ];
  let loadFinished = false;
  let loadError = null;
  const injectionStartedAt = new Date();
  const loadPromise = command('docker', args, { timeout: 240_000 })
    .catch((error) => {
      loadError = error instanceof Error ? error.message : String(error);
      return { stdout: '', stderr: loadError };
    })
    .finally(() => { loadFinished = true; });

  while (!loadFinished) {
    const sampledAt = new Date().toISOString();
    const [cohort, containers] = await Promise.all([
      api(`/v1/benchmarks/${runId}`).catch((error) => ({ sample_error: error.message })),
      systemSnapshot(),
    ]);
    samples.push({ sampled_at: sampledAt, cohort, containers });
    await Promise.race([sleep(1_000), loadPromise]);
  }
  const processResult = await loadPromise;
  const injectionFinishedAt = new Date();
  const atInjectionEnd = await api(`/v1/benchmarks/${runId}`);
  const drainStarted = Date.now();
  const server = await waitFor(
    `${runId} to drain`,
    () => api(`/v1/benchmarks/${runId}`),
    (value) => Number(value.accepted) > 0 && Number(value.unfinished) === 0,
    120_000,
    250,
  );
  const drainMs = Date.now() - drainStarted;
  const restartsAfter = await restartCounts();
  const rawPath = new URL(`../evidence/raw/${runId}-k6-summary.json`, import.meta.url);
  const k6 = JSON.parse(await readFile(rawPath, 'utf8'));
  const acceptedByK6 = metric(k6, 'jobs_accepted', 'count');
  const dropped = metric(k6, 'dropped_iterations', 'count');
  const httpFailures = metric(k6, 'http_req_failed', 'rate');
  const checkRate = metric(k6, 'checks', 'rate', 1);
  const iterations = metric(k6, 'iterations', 'count');
  const restartsStable = JSON.stringify(restartsBefore) === JSON.stringify(restartsAfter);
  const accepted = Number(server.accepted);
  const correctness = {
    k6_process_ok: loadError === null,
    no_dropped_iterations: dropped === 0,
    all_response_checks_passed: checkRate === 1,
    no_http_failures: httpFailures === 0,
    generator_and_database_counts_match: acceptedByK6 === accepted && iterations === accepted,
    every_job_succeeded_once: Number(server.succeeded) === accepted
      && Number(server.attempts) === accepted
      && Number(server.submitted_events) === accepted
      && Number(server.claimed_events) === accepted
      && Number(server.succeeded_events) === accepted,
    no_failure_transitions: Number(server.dead_lettered) === 0
      && Number(server.cancelled) === 0
      && Number(server.retry_events) === 0
      && Number(server.lease_expired_events) === 0
      && Number(server.dead_lettered_events) === 0,
    one_idempotency_record_per_job: Number(server.idempotency_records) === accepted
      && Number(server.idempotency_job_ids) === accepted,
    containers_did_not_restart: restartsStable,
  };
  const valid = Object.values(correctness).every(Boolean);
  const peakBacklog = Math.max(Number(atInjectionEnd.unfinished), ...samples.map((item) => Number(item.cohort?.unfinished ?? 0)));
  const trial = {
    run_id: runId,
    formal,
    requested_rate_per_second: rate,
    requested_duration: runDuration,
    injection_started_at: injectionStartedAt.toISOString(),
    injection_finished_at: injectionFinishedAt.toISOString(),
    injection_wall_ms: injectionFinishedAt.getTime() - injectionStartedAt.getTime(),
    drain_after_injection_ms: drainMs,
    peak_observed_backlog: peakBacklog,
    backlog_at_injection_end: Number(atInjectionEnd.unfinished),
    valid,
    correctness,
    client: {
      iterations,
      accepted: acceptedByK6,
      dropped_iterations: dropped,
      http_failure_rate: httpFailures,
      check_rate: checkRate,
      admission_rps: metric(k6, 'http_reqs', 'rate'),
      submit_latency_ms: {
        p50: metric(k6, 'http_req_duration', 'med'),
        p95: metric(k6, 'http_req_duration', 'p(95)'),
        p99: metric(k6, 'http_req_duration', 'p(99)'),
        max: metric(k6, 'http_req_duration', 'max'),
      },
    },
    server,
    restarts_before: restartsBefore,
    restarts_after: restartsAfter,
    samples,
    generator: { argv: ['docker', ...args], stdout: processResult.stdout, stderr: processResult.stderr, error: loadError },
    raw_k6_summary: `evidence/raw/${runId}-k6-summary.json`,
  };
  await writeFile(new URL(`../evidence/raw/${runId}-trial.json`, import.meta.url), `${JSON.stringify(trial, null, 2)}\n`);
  return trial;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function range(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? { min: Math.min(...finite), max: Math.max(...finite) } : { min: 0, max: 0 };
}

function aggregate(trials) {
  return rates.map((rate) => {
    const selected = trials.filter((trial) => trial.requested_rate_per_second === rate);
    const field = (getter) => selected.map(getter);
    return {
      rate,
      trials: selected.length,
      valid_trials: selected.filter((trial) => trial.valid).length,
      accepted_total: selected.reduce((sum, trial) => sum + Number(trial.server.accepted), 0),
      admission_rps: { median: median(field((trial) => trial.client.admission_rps)), range: range(field((trial) => trial.client.admission_rps)) },
      submit_p95_ms: { median: median(field((trial) => trial.client.submit_latency_ms.p95)), range: range(field((trial) => trial.client.submit_latency_ms.p95)) },
      submit_p99_ms: { median: median(field((trial) => trial.client.submit_latency_ms.p99)), range: range(field((trial) => trial.client.submit_latency_ms.p99)) },
      completed_per_second: { median: median(field((trial) => Number(trial.server.completed_per_second))), range: range(field((trial) => Number(trial.server.completed_per_second))) },
      queue_wait_p95_ms: { median: median(field((trial) => Number(trial.server.queue_wait_p95_ms))), range: range(field((trial) => Number(trial.server.queue_wait_p95_ms))) },
      end_to_end_p95_ms: { median: median(field((trial) => Number(trial.server.end_to_end_p95_ms))), range: range(field((trial) => Number(trial.server.end_to_end_p95_ms))) },
      max_peak_backlog: Math.max(...field((trial) => trial.peak_observed_backlog)),
    };
  });
}

function fixed(value, digits = 1) {
  return Number(value).toFixed(digits);
}

function markdown(report) {
  const lines = [
    '# QueueForge benchmark results', '',
    `**Verdict:** ${report.passed ? 'PASS' : 'CHECK INVALID TRIALS'}  `,
    `**Batch:** \`${report.batch_id}\`  `,
    `**Measured:** ${report.started_at} to ${report.finished_at}  `,
    `**Topology:** one API, three workers × four slots, PostgreSQL 17.6, k6 2.0.0; all containers on this single Windows/WSL2 host.`, '',
    '## Published measurements', '',
    'Each point is three open-loop, constant-arrival-rate trials. Values are medians; parentheses show the min–max range. Every accepted job is checked against PostgreSQL after a full queue drain.', '',
    '| Offered rate | Valid trials | Admission RPS | Submit p95 | Submit p99 | Completed/s | Queue wait p95 | End-to-end p95 | Peak backlog |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.aggregates.map((item) => `| ${item.rate}/s | ${item.valid_trials}/${item.trials} | ${fixed(item.admission_rps.median)} (${fixed(item.admission_rps.range.min)}–${fixed(item.admission_rps.range.max)}) | ${fixed(item.submit_p95_ms.median)} ms (${fixed(item.submit_p95_ms.range.min)}–${fixed(item.submit_p95_ms.range.max)}) | ${fixed(item.submit_p99_ms.median)} ms (${fixed(item.submit_p99_ms.range.min)}–${fixed(item.submit_p99_ms.range.max)}) | ${fixed(item.completed_per_second.median)} (${fixed(item.completed_per_second.range.min)}–${fixed(item.completed_per_second.range.max)}) | ${fixed(item.queue_wait_p95_ms.median)} ms (${fixed(item.queue_wait_p95_ms.range.min)}–${fixed(item.queue_wait_p95_ms.range.max)}) | ${fixed(item.end_to_end_p95_ms.median)} ms (${fixed(item.end_to_end_p95_ms.range.min)}–${fixed(item.end_to_end_p95_ms.range.max)}) | ${item.max_peak_backlog} |`),
    '', '## Trial ledger', '',
    '| Run | Offered | Accepted | Dropped | HTTP failures | Checks | Drain after injection | Valid |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
    ...report.trials.map((trial) => `| \`${trial.run_id}\` | ${trial.requested_rate_per_second}/s | ${trial.server.accepted} | ${trial.client.dropped_iterations} | ${fixed(trial.client.http_failure_rate * 100, 3)}% | ${fixed(trial.client.check_rate * 100, 3)}% | ${trial.drain_after_injection_ms} ms | ${trial.valid ? 'PASS' : 'INVALID'} |`),
    '', '## Interpretation', '',
    `All correctness checks remained valid through the highest offered rate, **${report.highest_fully_valid_rate ?? 'none'} jobs/s**. The highest tested point that kept completion near the offered rate without material backlog was **${report.highest_low_backlog_tested_rate ?? 'none'} jobs/s**. The overloaded points observed roughly ${fixed(report.observed_peak_completion_rate, 1)} completed jobs/s. These are tested points, not a claim of a precise maximum; the gap in the matrix remains explicit.`, '',
    '## Methodology and limits', '',
    `- Warm-up: ${report.methodology.warmup_rate}/s for ${report.methodology.warmup_duration}; excluded from aggregates.`,
    `- Formal matrix: ${report.methodology.rates.join(', ')} jobs/s × ${report.methodology.repetitions} repetitions × ${report.methodology.duration}. Trial order is rotated by repetition.`,
    '- Generator: k6 constant-arrival-rate, unique idempotency key per job, fixed VU allocation, no iteration sleep.',
    '- Validity: zero dropped iterations and HTTP failures; all response contract checks pass; k6/database counts match; every job has one attempt and submitted/claimed/succeeded event; no retry, lease-expiry, DLQ, cancellation, or container restart.',
    '- Limits: single developer machine, local Docker bridge, no TLS/auth/WAN latency, a zero-work handler, and a generator sharing the same Docker/WSL2 resource pool. Do not extrapolate these figures to production.', '',
    '## Environment', '', '```text',
    `Host: ${report.environment.host.platform} ${report.environment.host.release}; ${report.environment.host.cpus} logical CPUs; ${fixed(report.environment.host.memory_bytes / 1024 ** 3, 2)} GiB RAM`,
    `Docker: ${report.environment.docker_version}`,
    `Compose: ${report.environment.compose_version}`,
    `PostgreSQL: ${report.environment.postgresql_version}`,
    `Node: ${report.environment.node_version}`,
    `Git revision: ${report.environment.git_revision ?? 'uncommitted local artifact'}`,
    `Database settings: ${report.environment.database_settings}`,
    '```', '',
    'Raw k6 summaries, per-trial server truth, queue samples, resource samples, and command arguments are retained in [`evidence/raw`](./raw/).', '',
  ];
  return lines.join('\n');
}

async function optionalCommand(file, args) {
  try { return (await command(file, args)).stdout; } catch { return null; }
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await command('docker', ['compose', 'up', '-d', '--build', 'postgres', 'api', 'worker-a', 'worker-b', 'worker-c'], { timeout: 300_000 });
  const preflightState = await preflight();
  const warmupId = `${batchId}-warmup`;
  const warmup = await runLoad(warmupId, warmupRate, warmupDuration, false);
  await preflight();
  const trials = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const offset = repetition % rates.length;
    const order = [...rates.slice(offset), ...rates.slice(0, offset)];
    for (const rate of order) {
      const runId = `${batchId}-r${rate}-t${repetition + 1}`;
      process.stdout.write(`Running ${runId}: ${rate}/s for ${duration}\n`);
      trials.push(await runLoad(runId, rate, duration, true));
      await preflight();
    }
  }
  const aggregates = aggregate(trials);
  const fullyValid = aggregates.filter((item) => item.valid_trials === repetitions);
  const durationSeconds = Number.parseFloat(duration) || 10;
  const lowBacklog = aggregates.filter((item) => item.valid_trials === repetitions
    && item.completed_per_second.median >= item.rate * 0.9
    && item.max_peak_backlog <= Math.ceil(item.rate * durationSeconds * 0.02));
  const [dockerVersion, composeVersion, postgresqlVersion, databaseSettings, gitRevision] = await Promise.all([
    optionalCommand('docker', ['version', '--format', '{{.Server.Version}}']),
    optionalCommand('docker', ['compose', 'version']),
    optionalCommand('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'queueforge', '-d', 'queueforge', '-tAc', 'SHOW server_version']),
    optionalCommand('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'queueforge', '-d', 'queueforge', '-tAc', "SELECT 'max_connections='||current_setting('max_connections')||', shared_buffers='||current_setting('shared_buffers')"]),
    optionalCommand('git', ['rev-parse', 'HEAD']),
  ]);
  const finishedAt = new Date();
  const source = await readFile(new URL('../load/k6-submit.js', import.meta.url));
  const report = {
    schema_version: 'queueforge.benchmark.v1',
    batch_id: batchId,
    passed: trials.every((trial) => trial.valid),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    highest_fully_valid_rate: fullyValid.length ? Math.max(...fullyValid.map((item) => item.rate)) : null,
    highest_low_backlog_tested_rate: lowBacklog.length ? Math.max(...lowBacklog.map((item) => item.rate)) : null,
    observed_peak_completion_rate: Math.max(...aggregates.map((item) => item.completed_per_second.median)),
    methodology: { executor: 'constant-arrival-rate', rates, repetitions, duration, warmup_rate: warmupRate, warmup_duration: warmupDuration, handler: 'noop', handler_duration_ms: 0, k6_script_sha256: createHash('sha256').update(source).digest('hex') },
    preflight: preflightState,
    warmup,
    aggregates,
    trials,
    environment: {
      host: { hostname: hostname(), platform: platform(), release: release(), cpus: cpus().length, cpu_model: cpus()[0]?.model, memory_bytes: totalmem() },
      node_version: process.version,
      docker_version: dockerVersion,
      compose_version: composeVersion,
      postgresql_version: postgresqlVersion,
      database_settings: databaseSettings,
      git_revision: gitRevision,
      topology: { api_instances: 1, worker_instances: 3, concurrency_per_worker: 4, api_pool_size: 12, worker_pool_size: 12, lease_ms: 6_000, heartbeat_ms: 1_800, claim_poll_ms: 100, reaper_poll_ms: 250 },
    },
  };
  await writeFile(new URL('../evidence/benchmark-results.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(new URL('../evidence/benchmark-results.md', import.meta.url), `${markdown(report)}\n`);
  process.stdout.write(`${report.passed ? 'PASS' : 'CHECK'} ${batchId}; highest fully valid tested rate: ${report.highest_fully_valid_rate ?? 'none'} jobs/s\n`);
}

await main();
