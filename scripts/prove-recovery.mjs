import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const baseUrl = process.env.QUEUEFORGE_API ?? 'http://localhost:18080';
const runId = `recovery-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
const startedAt = new Date();
const assertions = [];
const scenarios = {};
const touchedServices = new Set();
let fatalError = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(args) {
  const result = await execFile('docker', args, { cwd: root, timeout: 120_000, windowsHide: true });
  return result.stdout.trim();
}

async function compose(...args) {
  return command(['compose', ...args]);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}

async function waitFor(label, probe, predicate, timeoutMs = 45_000, intervalMs = 100) {
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
  throw new Error(`Timed out waiting for ${label}; last observation: ${JSON.stringify(last)}`);
}

function check(name, condition, detail) {
  const passed = Boolean(condition);
  assertions.push({ name, passed, detail });
  if (!passed) throw new Error(`Assertion failed: ${name} (${JSON.stringify(detail)})`);
}

async function submit(body, idempotencyKey) {
  return api('/v1/jobs', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey, 'x-client-id': 'recovery-proof' },
    body: JSON.stringify(body),
  });
}

async function job(id) {
  const response = await api(`/v1/jobs/${id}`);
  if (response.status !== 200) throw new Error(`Job ${id} returned HTTP ${response.status}`);
  return response.body.data;
}

async function effect(id) {
  const response = await api(`/v1/demo/effects/${id}`);
  if (response.status !== 200) throw new Error(`Effect ${id} returned HTTP ${response.status}`);
  return response.body.data;
}

async function waitForHealthy() {
  await waitFor('ready API', () => api('/health/ready'), (response) => response.status === 200, 60_000, 250);
}

async function waitForWorkers(minimum = 3) {
  return waitFor(
    `${minimum} active workers`,
    () => api('/v1/workers'),
    (response) => response.status === 200
      && response.body.data.filter((worker) => worker.status === 'active').length >= minimum,
    30_000,
    250,
  );
}

function serviceFor(workerName) {
  if (!['worker-a', 'worker-b', 'worker-c'].includes(workerName)) {
    throw new Error(`Cannot map worker name to a Compose service: ${workerName}`);
  }
  return workerName;
}

async function killService(service) {
  touchedServices.add(service);
  const container = `queueforge-${service}`;
  const identity = JSON.parse(await command(['inspect', '--format', '{{json .Config.Labels}}', container]));
  check(`kill target ${service} belongs to the QueueForge Compose project`,
    identity['com.docker.compose.project'] === 'queueforge'
      && identity['com.docker.compose.service'] === service,
    identity);
  await command(['kill', '--signal=KILL', container]);
  const state = JSON.parse(await command(['inspect', '--format', '{{json .State}}', container]));
  check(`hard kill of ${service} exits with SIGKILL semantics`,
    state.Status === 'exited' && Number(state.ExitCode) === 137 && state.OOMKilled === false,
    { status: state.Status, exit_code: state.ExitCode, oom_killed: state.OOMKilled });
  return state;
}

async function startService(service) {
  touchedServices.add(service);
  await compose('up', '-d', service);
}

async function testSubmissionIdempotency() {
  const key = `${runId}-same-request`;
  const availableAt = new Date(Date.now() + 120_000).toISOString();
  const body = {
    queue: 'default', type: 'noop', payload: { duration_ms: 0 },
    available_at: availableAt,
    max_attempts: 3, timeout_ms: 10_000, backoff_base_ms: 50, backoff_cap_ms: 250,
  };
  const responses = await Promise.all(Array.from({ length: 20 }, () => submit(body, key)));
  const first = responses.find((response) => response.status === 202);
  const ids = responses.map((response) => response.body?.data?.id);
  const statusCounts = {
    202: responses.filter((response) => response.status === 202).length,
    200: responses.filter((response) => response.status === 200).length,
  };
  const conflict = await submit({ ...body, priority: 1 }, key);
  check('twenty concurrent identical requests create exactly one job',
    statusCounts[202] === 1
      && statusCounts[200] === 19
      && new Set(ids).size === 1,
    { status_counts: statusCounts, unique_job_ids: new Set(ids).size });
  check('same key with different intent is rejected', conflict.status === 409,
    { status: conflict.status, problem: conflict.body?.type });
  const cancelled = await api(`/v1/jobs/${first.body.data.id}/cancel`, { method: 'POST', body: '{}' });
  check('scheduled idempotency probe is cleaned up by cancellation', cancelled.status === 200 && cancelled.body.data.status === 'cancelled',
    { status: cancelled.status, job_status: cancelled.body?.data?.status });
  scenarios.idempotency = {
    key_hash_only: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then((value) => Buffer.from(value).toString('hex')),
    job_id: first.body.data.id, request_count: responses.length,
    status_counts: statusCounts,
    unique_job_ids: new Set(ids).size,
    conflict_status: conflict.status,
  };
}

async function testDirectFencing() {
  const database = `queueforge_proof_${runId.slice(-12).toLowerCase()}`;
  if (!/^queueforge_proof_[a-z0-9]{12}$/.test(database)) throw new Error(`Unsafe temporary database name: ${database}`);
  let removed = false;
  let output = '';
  try {
    await compose('exec', '-T', 'postgres', 'createdb', '-U', 'queueforge', database);
    const vitest = new URL('../backend/node_modules/vitest/vitest.mjs', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
    const result = await execFile(process.execPath, [
      vitest, 'run', 'src/integration.test.ts',
      '-t', 'fences stale workers after lease expiry and permits the replacement to settle',
      '--maxWorkers=1', '--no-file-parallelism',
    ], {
      cwd: new URL('../backend/', import.meta.url).pathname.replace(/^\/(.:)/, '$1'),
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, TEST_DATABASE_URL: `postgresql://queueforge:queueforge-local-only@localhost:54329/${database}` },
    });
    output = `${result.stdout}\n${result.stderr}`.trim();
    check('isolated store-level test rejects stale settlement after lease generation changes',
      /1 passed/.test(output) && !/failed/i.test(output), { test: 'stale lease fencing', result: 'passed' });
  } finally {
    try {
      await compose('exec', '-T', 'postgres', 'dropdb', '--force', '-U', 'queueforge', database);
      removed = true;
    } catch { /* reflected by assertion */ }
    await mkdir(new URL('../evidence/raw/', import.meta.url), { recursive: true });
    await writeFile(new URL('../evidence/raw/recovery-fencing-test.txt', import.meta.url), `${output}\n`);
  }
  check('temporary fencing-test database is removed', removed, { database_hash_suffix: database.slice(-12) });
  scenarios.direct_fencing = { test_name: 'fences stale workers after lease expiry and permits the replacement to settle', passed: true, temporary_database_removed: removed, raw_output: 'evidence/raw/recovery-fencing-test.txt' };
}

async function testCrashAfterEffect() {
  const submitted = await submit({
    queue: 'critical', type: 'idempotent_counter',
    payload: { effect_key: runId, value: 1, sleep_after_effect_ms: 9_000 },
    max_attempts: 3, timeout_ms: 30_000, backoff_base_ms: 100, backoff_cap_ms: 250,
  }, `${runId}-after-effect`);
  check('after-effect crash job is accepted', submitted.status === 202, { status: submitted.status });
  const id = submitted.body.data.id;
  const observed = await waitFor(
    'first durable effect while its lease is running',
    async () => ({ job: await job(id), effect: await effect(id) }),
    (value) => value.job.status === 'running' && value.effect.logicalEffectCount === 1,
    20_000,
    100,
  );
  const killedWorker = observed.job.lease_owner_name;
  const killedWorkerId = observed.job.lease_owner;
  const killedGeneration = observed.job.lease_generation;
  const killedAt = new Date();
  const service = serviceFor(killedWorker);
  const killedState = await killService(service);

  const recovered = await waitFor('crashed job recovery', () => job(id), (value) => value.status === 'succeeded', 40_000, 200);
  const finalEffect = await effect(id);
  const recoveryMs = Date.now() - killedAt.getTime();
  const types = recovered.events.map((event) => event.type);
  const firstAttempt = recovered.attempts[0];
  const secondAttempt = recovered.attempts[1];
  check('hard-killed attempt is durably marked lease_expired', firstAttempt?.outcome === 'lease_expired', firstAttempt);
  check('a replacement attempt succeeds', secondAttempt?.outcome === 'succeeded' && recovered.attempts.length === 2,
    recovered.attempts);
  check('replacement is fenced by a newer generation', Number(secondAttempt?.lease_generation) > Number(killedGeneration),
    { killed_generation: killedGeneration, replacement_generation: secondAttempt?.lease_generation });
  check('replacement uses another worker incarnation', secondAttempt?.worker_id !== killedWorkerId,
    { killed_worker_id: killedWorkerId, replacement_worker_id: secondAttempt?.worker_id });
  check('the handler executed twice but its durable logical effect occurred once',
    finalEffect.visits.length === 2 && finalEffect.logicalEffectCount === 1,
    { visits: finalEffect.visits.length, logical_effect_count: finalEffect.logicalEffectCount });
  const requiredOrder = ['claimed', 'lease_expired', 'retry_scheduled', 'claimed', 'succeeded'];
  let position = -1;
  const ordered = requiredOrder.every((type) => {
    position = types.indexOf(type, position + 1);
    return position >= 0;
  });
  check('audit events prove claim-expiry-retry-reclaim-success order', ordered, { event_types: types });
  check('recovery finishes within the documented 40 second bound', recoveryMs < 40_000, { recovery_ms: recoveryMs });

  scenarios.crash_after_effect = {
    job_id: id,
    killed_at: killedAt.toISOString(),
    killed_service: service,
    killed_worker_id: killedWorkerId,
    killed_generation: killedGeneration,
    killed_container_state: { exit_code: killedState.ExitCode, oom_killed: killedState.OOMKilled },
    recovered_at: new Date().toISOString(),
    recovery_ms: recoveryMs,
    attempts: recovered.attempts,
    events: recovered.events,
    effect: finalEffect,
  };
  await startService(service);
  await waitForWorkers(3);
  return service;
}

async function testCrashBeforeEffect(excludedService) {
  await compose('stop', excludedService);
  touchedServices.add(excludedService);
  await waitForWorkers(2);
  const submitted = await submit({
    queue: 'critical', type: 'idempotent_counter',
    payload: { effect_key: `${runId}-before`, value: 1, sleep_before_effect_ms: 9_000 },
    max_attempts: 3, timeout_ms: 30_000, backoff_base_ms: 100, backoff_cap_ms: 250,
  }, `${runId}-before-effect`);
  check('before-effect crash job is accepted', submitted.status === 202, { status: submitted.status });
  const id = submitted.body.data.id;
  const running = await waitFor('job running before its effect', () => job(id), (value) => value.status === 'running', 10_000, 50);
  const killedService = serviceFor(running.lease_owner_name);
  check('second hard kill targets a different worker service', killedService !== excludedService,
    { first_service: excludedService, second_service: killedService });
  const killedAt = new Date();
  const killedState = await killService(killedService);
  const recovered = await waitFor('pre-effect crash recovery', () => job(id), (value) => value.status === 'succeeded', 40_000, 200);
  const finalEffect = await effect(id);
  const recoveryMs = Date.now() - killedAt.getTime();
  check('pre-effect killed attempt expires and replacement succeeds',
    recovered.attempts.length === 2
      && recovered.attempts[0].outcome === 'lease_expired'
      && recovered.attempts[1].outcome === 'succeeded', recovered.attempts);
  check('effect delayed until the replacement attempt is still applied once',
    finalEffect.logicalEffectCount === 1 && finalEffect.visits.length === 1
      && Number(finalEffect.visits[0]?.attempt_no) === 2,
    finalEffect);
  scenarios.crash_before_effect = {
    job_id: id, killed_at: killedAt.toISOString(), killed_service: killedService,
    excluded_first_service: excludedService, recovery_ms: recoveryMs,
    killed_container_state: { exit_code: killedState.ExitCode, oom_killed: killedState.OOMKilled },
    attempts: recovered.attempts, events: recovered.events, effect: finalEffect,
  };
  await Promise.all([startService(killedService), startService(excludedService)]);
  await waitForWorkers(3);
}

async function testRetriesDlqAndRedrive() {
  const response = await submit({
    queue: 'default', type: 'always_fail',
    payload: { message: 'proof poison job', retryable: true },
    max_attempts: 3, timeout_ms: 10_000, backoff_base_ms: 50, backoff_cap_ms: 100,
  }, `${runId}-poison`);
  check('poison job is accepted', response.status === 202, { status: response.status });
  const sourceId = response.body.data.id;
  const dead = await waitFor('poison job in DLQ', () => job(sourceId), (value) => value.status === 'dead_lettered', 20_000, 100);
  check('poison job consumes exactly its three allowed attempts', dead.attempts.length === 3, dead.attempts);
  check('poison job schedules two retries before DLQ',
    dead.events.filter((event) => event.type === 'retry_scheduled').length === 2,
    { event_types: dead.events.map((event) => event.type) });
  const letters = await api('/v1/dead-letters?limit=200');
  check('DLQ exposes the terminal source job',
    letters.status === 200 && letters.body.data.some((letter) => letter.job_id === sourceId),
    { status: letters.status, source_job_id: sourceId });

  const redriveKey = `${runId}-redrive`;
  const first = await api(`/v1/dead-letters/${sourceId}/redrive`, {
    method: 'POST', headers: { 'idempotency-key': redriveKey, 'x-client-id': 'recovery-proof' }, body: '{}',
  });
  const replay = await api(`/v1/dead-letters/${sourceId}/redrive`, {
    method: 'POST', headers: { 'idempotency-key': redriveKey, 'x-client-id': 'recovery-proof' }, body: '{}',
  });
  check('redrive creates a different immutable job', first.status === 202 && first.body.data.id !== sourceId,
    { status: first.status, source: sourceId, destination: first.body?.data?.id });
  check('redrive request is itself idempotent', replay.status === 200 && replay.body.data.id === first.body.data.id,
    { status: replay.status, first: first.body?.data?.id, replay: replay.body?.data?.id });
  const destination = await waitFor('redriven poison job terminal state', () => job(first.body.data.id),
    (value) => value.status === 'dead_lettered', 20_000, 100);
  const sourceAfter = await job(sourceId);
  check('redrive preserves the original DLQ record', sourceAfter.status === 'dead_lettered', { status: sourceAfter.status });
  scenarios.retry_dlq_redrive = {
    source_job_id: sourceId, source_attempts: dead.attempts, source_events: sourceAfter.events,
    destination_job_id: destination.id, destination_status: destination.status,
    first_redrive_status: first.status, replay_redrive_status: replay.status,
  };
}

async function testCancellation() {
  const response = await submit({
    queue: 'default', type: 'noop', payload: { duration_ms: 10_000 },
    max_attempts: 3, timeout_ms: 20_000, backoff_base_ms: 50, backoff_cap_ms: 100,
  }, `${runId}-cancel`);
  const id = response.body.data.id;
  await waitFor('cancellable running job', () => job(id), (value) => value.status === 'running', 10_000, 50);
  const requested = await api(`/v1/jobs/${id}/cancel`, { method: 'POST', body: '{}' });
  const cancelled = await waitFor('cooperative cancellation', () => job(id), (value) => value.status === 'cancelled', 10_000, 100);
  check('running cancellation is acknowledged asynchronously', requested.status === 202, { status: requested.status });
  check('running handler cooperatively reaches cancelled', cancelled.status === 'cancelled'
    && cancelled.attempts[0]?.outcome === 'cancelled', cancelled.attempts);
  scenarios.cancellation = { job_id: id, request_status: requested.status, attempts: cancelled.attempts, events: cancelled.events };
}

async function testPersistence() {
  const id = scenarios.crash_after_effect.job_id;
  const before = await job(id);
  await compose('restart', 'api');
  await waitForHealthy();
  const after = await job(id);
  check('API restart preserves job, attempts, events, and result in PostgreSQL',
    after.id === before.id
      && after.status === 'succeeded'
      && after.attempts.length === before.attempts.length
      && after.events.length === before.events.length
      && JSON.stringify(after.result) === JSON.stringify(before.result),
    { before: { status: before.status, attempts: before.attempts.length, events: before.events.length },
      after: { status: after.status, attempts: after.attempts.length, events: after.events.length } });
  scenarios.persistence = { job_id: id, api_restarted: true, status_after_restart: after.status,
    attempts_after_restart: after.attempts.length, events_after_restart: after.events.length };
}

function markdown(report) {
  const lines = [
    '# QueueForge crash-recovery evidence', '',
    `**Verdict:** ${report.passed ? 'PASS' : 'FAIL'}`,
    `**Run:** \`${report.run_id}\`  `,
    `**Started:** ${report.started_at}  `,
    `**Finished:** ${report.finished_at}  `,
    `**Duration:** ${report.duration_ms} ms`, '',
    '## What was proved', '',
    '| Scenario | Evidence |', '|---|---|',
    `| Crash after durable effect | Worker \`${report.scenarios.crash_after_effect?.killed_service ?? 'n/a'}\` was hard-killed; job recovered in ${report.scenarios.crash_after_effect?.recovery_ms ?? 'n/a'} ms; two executions produced one durable effect. |`,
    `| Crash before effect | A different worker \`${report.scenarios.crash_before_effect?.killed_service ?? 'n/a'}\` was hard-killed; the surviving worker completed attempt 2 and produced one effect. |`,
    `| Submission idempotency | ${report.scenarios.idempotency?.request_count ?? 'n/a'} concurrent requests resolved to ${report.scenarios.idempotency?.unique_job_ids ?? 'n/a'} job (${report.scenarios.idempotency?.status_counts?.[202] ?? 'n/a'} accepted, ${report.scenarios.idempotency?.status_counts?.[200] ?? 'n/a'} replayed); conflicting reuse returned ${report.scenarios.idempotency?.conflict_status ?? 'n/a'}. |`,
    `| Retry + DLQ + redrive | Poison job made ${report.scenarios.retry_dlq_redrive?.source_attempts?.length ?? 'n/a'} attempts, entered the DLQ, and redrive remained idempotent without mutating the source. |`,
    `| Cancellation | Running job reached \`${report.scenarios.cancellation?.attempts?.[0]?.outcome ?? 'n/a'}\`. |`,
    `| Persistence | API container restart retained ${report.scenarios.persistence?.attempts_after_restart ?? 'n/a'} attempts and ${report.scenarios.persistence?.events_after_restart ?? 'n/a'} events. |`, '',
    '## Assertions', '', '| Result | Assertion | Detail |', '|---|---|---|',
    ...report.assertions.map((item) => `| ${item.passed ? 'PASS' : 'FAIL'} | ${item.name} | \`${JSON.stringify(item.detail).replaceAll('|', '\\|')}\` |`),
    '', '## Recovery timeline', '',
    'The first crash is intentionally placed after the demo handler commits its business effect but before QueueForge acknowledges success. The lease expires, another worker obtains a strictly newer generation, and the unique `demo_effects(job_id)` guard prevents a duplicated logical effect even though the handler is delivered twice.', '',
    `Machine-readable evidence: [recovery-proof.json](./recovery-proof.json)`, '',
    '## Environment', '', '```text', report.environment.docker_version, report.environment.compose_version, report.environment.services_after, '```', '',
  ];
  if (report.error) lines.push('## Failure', '', '```text', report.error, '```', '');
  return lines.join('\n');
}

async function main() {
  let servicesBefore = '';
  try {
    await compose('up', '-d', 'postgres', 'api', 'worker-a', 'worker-b', 'worker-c');
    await waitForHealthy();
    await waitForWorkers(3);
    await waitFor('quiescent queue before fault injection', () => api('/v1/dashboard/summary'),
      (response) => response.status === 200
        && Number(response.body.data.counts.ready) === 0
        && Number(response.body.data.counts.running) === 0
        && Number(response.body.data.counts.retry_wait) === 0,
      30_000, 250);
    servicesBefore = await compose('ps');
    await testSubmissionIdempotency();
    await testDirectFencing();
    const firstKilledService = await testCrashAfterEffect();
    await testCrashBeforeEffect(firstKilledService);
    await testRetriesDlqAndRedrive();
    await testCancellation();
    await testPersistence();
  } catch (error) {
    fatalError = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  } finally {
    for (const service of touchedServices) {
      try { await startService(service); } catch { /* captured through final service state */ }
    }
    try { await waitForHealthy(); } catch { /* report below */ }
    let dockerVersion = 'unavailable';
    let composeVersion = 'unavailable';
    let servicesAfter = 'unavailable';
    try { dockerVersion = await command(['version', '--format', '{{.Server.Version}}']); } catch { /* report */ }
    try { composeVersion = await command(['compose', 'version']); } catch { /* report */ }
    try { servicesAfter = await compose('ps'); } catch { /* report */ }
    const finishedAt = new Date();
    const report = {
      schema_version: 1,
      run_id: runId,
      passed: !fatalError && assertions.length > 0 && assertions.every((item) => item.passed),
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      contract: 'at-least-once execution with fenced leases; idempotent handler effects are demonstrated separately',
      settings: { lease_ms: 6_000, heartbeat_ms: 1_800, reaper_poll_ms: 250 },
      assertions,
      scenarios,
      environment: { base_url: baseUrl, docker_version: dockerVersion, compose_version: composeVersion, services_before: servicesBefore, services_after: servicesAfter },
      error: fatalError,
    };
    await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
    await writeFile(new URL('../evidence/recovery-proof.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(new URL('../evidence/recovery-proof.md', import.meta.url), `${markdown(report)}\n`);
    process.stdout.write(`${report.passed ? 'PASS' : 'FAIL'} ${report.run_id}: ${assertions.filter((item) => item.passed).length}/${assertions.length} assertions passed\n`);
    if (!report.passed) process.exitCode = 1;
  }
}

await main();
