# Verification strategy

## Layers

### Unit tests

Current tests cover canonical JSON stability, key-order-independent fingerprints, SHA-256 behavior, and deterministic bounds/capping for full-jitter exponential backoff.

### Real PostgreSQL integration tests

`npm run core:test:integration` creates a disposable, randomly named PostgreSQL database and tests:

- Twenty concurrent identical idempotent submissions resolve to one job and one winner.
- Conflicting reuse is rejected.
- Ten concurrent consumers claim 100 ready jobs once per generation.
- Expired generation 1 cannot settle after generation 2 claims; generation 2 can.
- A retryable poison job reaches the DLQ after exactly its configured attempts.
- Ready cancellation is immediate and running cancellation is cooperative/fenced.

SQLite is deliberately not used for these concurrency claims.

### Black-box recovery proof

`npm run proof:recovery` uses only public HTTP observation, allowlisted Docker operations, and the isolated store test. It verifies container labels before killing; only `queueforge-worker-a`, `-b`, or `-c` can be a target. A successful kill must show exited state, exit code 137, and `OOMKilled=false`.

The two deterministic windows are:

- Before effect: first attempt is sleeping before `applyDemoEffect`; only replacement attempt reaches the effect.
- After effect/before acknowledgement: first attempt has committed the effect and is sleeping; replacement visits the effect code but the job primary key prevents duplication.

Every run writes JSON and Markdown even on failure and restores touched workers in `finally`.

### Load test

`npm run bench` uses open-loop k6 injection. Each job has a unique idempotency key and run-scoped client ID. The generator checks status 202, a v4 job UUID, exact `Location`, and non-replay metadata.

A formal trial is valid only when:

- k6 exits normally;
- dropped iterations = 0;
- all response checks pass;
- HTTP failure rate = 0;
- generator iterations/accepted count equals the database cohort;
- every job succeeds with one attempt;
- submitted, claimed, and succeeded event counts each equal accepted jobs;
- retry, lease-expiry, DLQ, and cancellation counts are zero;
- idempotency record and distinct job counts equal accepted jobs;
- no core container restart count changes;
- the cohort fully drains by the bounded deadline.

Resource and cohort samples are retained alongside the complete k6 summary.

## Regression matrix

Before changing claim/lease logic, add or retain tests for:

| Area | Required cases |
|---|---|
| State transitions | Every legal transition; every terminal mutation rejected. |
| Idempotency | Concurrent same key/body, same key/different body, defaults/key ordering, expiry policy. |
| Claiming | More claimers than jobs, priorities, future schedule, queue filters, no duplicate current generation. |
| Fencing | Stale heartbeat/success/failure/cancel, expired-but-not-reaped token, heartbeat/reaper race. |
| Retry | Off-by-one, cap, overflow, jitter bounds, permanent error, timeout, cancellation precedence. |
| DLQ/redrive | Atomic final attempt + DLQ + event; source immutability; redrive idempotency. |
| Cancellation | Ready, running, complete/cancel race, crash after request. |
| Persistence | API, worker, and PostgreSQL service restart while preserving durable entities. |
| Validation | Names, headers, cursor, horizon, byte limits, handler schemas, oversized errors/results. |
| Observability | Bounded labels, event consistency, SSE reconnect/refetch. |
| Operations | DB loss/reconnect, pool starvation, graceful drain deadline, worker version capability. |

## Post-test invariants

- No nonterminal job is permanently stranded without a path to claim/reap.
- No terminal row owns a lease.
- No open attempt belongs to a non-running job.
- Attempt numbers and lease generations are strictly increasing.
- A DLQ job has exactly one dead-letter row.
- Every durable transition has the expected event.
- Idempotency scope has no key-to-multiple-job mapping.

## Honest benchmark reporting

Never publish only an average, a best trial, or an admission rate as processing throughput. Report workload, topology, hardware, duration, repetitions, min/median/max or percentiles, generator drops, error/correctness counts, backlog/drain time, and limitations. Preserve invalid runs; do not silently discard them.
