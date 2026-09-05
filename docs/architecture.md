# Architecture and invariants

## Design goal

QueueForge is intentionally one durable queue implementation, not a framework abstraction over multiple brokers. PostgreSQL is the serialization point for job state, attempts, results, audit events, idempotency, worker registry, demo effects, and the DLQ. That choice makes transactional boundaries inspectable and prevents a broker/database dual-write gap.

## Components

- The API validates bounded input, canonicalizes semantic requests, reserves idempotency keys, and reads operator state.
- Each worker process is a fresh UUID incarnation with a name, queue allowlist, and fixed number of execution slots.
- Every worker runs independent claim, job-heartbeat, worker-heartbeat, and expired-lease reaper loops.
- PostgreSQL is the sole authority for lease ownership and time.
- The dashboard is a read-mostly control plane with submit, cancel, and redrive actions.
- The evidence harnesses are first-class clients; they fail nonzero when durable facts contradict expected invariants.

## Durable entities

### `jobs`

Current state and policy: type, queue, JSON payload, priority, `available_at`, attempts, timeout, backoff parameters, lease owner/token/generation/deadline, cancel request, result/error, redrive source, timestamps, and revision.

Checks enforce:

- Only known states.
- Bounds on priority, attempts, timeout, and backoff.
- A running job has all lease fields; a non-running job has none.
- A terminal job has `finished_at`; a nonterminal job does not.

### `idempotency_records`

The primary key is `(client_id, operation, SHA-256(key))`. The raw key is never stored. A record includes the canonical request fingerprint, job ID, and a seven-day expiry timestamp. The foreign key is deferred so reservation and job insertion can occur in one transaction.

### `job_attempts`

Exactly one row per `(job_id, attempt_no)`, with a globally unique token, generation, worker, claim/heartbeat/finish timestamps, outcome, bounded error, chosen retry delay, and duration.

### `job_events`

An immutable, monotonic event ledger. Every state-changing transaction writes its corresponding event before commit.

### `workers`

A row represents a process incarnation, not a reusable hostname/PID. Online/offline is derived from PostgreSQL time and heartbeat age. Old incarnations remain useful evidence.

### `dead_letters` and `job_redrives`

A terminal snapshot and immutable source/destination relation. Redrive does not reopen the old job.

## Atomic submission

With an idempotency key:

1. Fully validated values and defaults form a canonical, key-sorted semantic JSON document.
2. SHA-256 produces a request fingerprint; a separate SHA-256 hashes the key.
3. `INSERT ... ON CONFLICT DO NOTHING` reserves the scoped key.
4. If another transaction won, a new statement reads the committed record. Equal fingerprint returns its job; unequal fingerprint raises `409`.
5. The winning transaction inserts the job and `submitted` event.
6. Commit makes reservation, job, and event visible together.

Without a key, each accepted request creates a new job. The API allows this deliberately; reliable clients should send keys.

## Atomic claim

At `READ COMMITTED`, a worker asks only for its number of free slots:

```sql
SELECT id
FROM jobs
WHERE status IN ('queued', 'retry_wait')
  AND queue = ANY($queues)
  AND available_at <= clock_timestamp()
  AND cancel_requested_at IS NULL
  AND attempts_started < max_attempts
ORDER BY priority DESC, available_at, created_at, id
FOR UPDATE SKIP LOCKED
LIMIT $free_slots;
```

While those rows are locked, the same short transaction:

- changes each row to `running`;
- increments `attempts_started` and `lease_generation`;
- assigns a new UUID token and worker incarnation;
- sets the deadline and heartbeat using `clock_timestamp()`;
- inserts the attempt;
- inserts the `claimed` event;
- commits before handler work begins.

No database lock is held while user work executes. No worker prefetches more jobs than it can immediately run.

## Lease fencing

The current attempt may heartbeat or settle only when all of these remain true:

```text
job id matches
status == running
lease token matches
lease generation matches
lease_expires_at > database_now
```

A zero-row update means ownership is gone. An expired token cannot revive its lease, even before a reaper records expiry. Tokens stay internal; public job APIs expose the owner and generation for observation, not the secret token.

The generation is a monotonic fence. Systems capable of accepting a fence can reject effects from earlier generations. Systems without fencing still require an application idempotency key or transactional outbox/inbox.

## Reaper transaction

All workers may reap. Each locks a small ordered batch of expired running rows with `SKIP LOCKED`, so only one reaper owns each transition.

For every expired row, one transaction:

1. Closes the open attempt as `lease_expired`.
2. Writes `lease_expired`.
3. If cancellation was pending, settles `cancelled`.
4. Else if attempts are exhausted, atomically updates the job, inserts the DLQ record, and writes `dead_lettered`.
5. Else calculates full-jitter backoff, changes the job to `retry_wait`, clears lease fields, and records `retry_scheduled`.

The dead process cannot report its own death. The reaper’s durable event is authoritative.

## Retry and failure classification

- `RetryableJobError` and unknown handler exceptions retry until the total-attempt limit.
- Timeout is retryable until the limit.
- `PermanentJobError` and payload validation failure go directly to the DLQ.
- Cancellation takes precedence over a retry when the worker observes it.
- Error type is capped at 128 characters and message at 2,000.
- Full jitter is persisted so the chosen schedule is auditable.

## Cancellation races

- A queued/retry-wait cancel locks and immediately settles the job.
- A running cancel writes `cancel_requested_at`; the next heartbeat aborts the handler and performs a fenced cancel.
- If the handler’s success transaction wins first, the later cancel sees a terminal job.
- If cancellation is committed first, success requires `cancel_requested_at IS NULL` and is rejected.
- If the worker dies after a request, the reaper sees the flag and settles cancelled instead of retrying.

Cancellation is cooperative. QueueForge does not isolate every handler in a killable subprocess.

## Invariants

After every transaction:

- At most one current valid lease exists per job.
- Attempt number and lease generation strictly increase together.
- A stale or expired attempt cannot heartbeat, succeed, fail, or cancel the current job.
- A terminal job has no active lease.
- Every claimed generation has exactly one attempt row.
- A state change and its lifecycle event commit together.
- A dead-lettered job has one DLQ row.
- Redrive creates a different job and preserves its terminal source.
- One unexpired scoped idempotency key maps to one semantic request/job.
- Handler effects remain outside QueueForge’s exactly-once authority.

## Ordering and fairness

Ready work is ordered by priority descending, then availability, creation time, and UUID. `SKIP LOCKED` and concurrent consumers make this best effort rather than a strict total order. Sustained high-priority input may starve low-priority jobs; production variants could add priority aging or weighted queues.

## Indexing

- `jobs_ready_idx`: partial queue/priority/availability index for queued and retry-wait rows.
- `jobs_expired_lease_idx`: partial lease deadline index for running rows.
- `jobs_status_created_idx`: dashboard/filter reads.
- `jobs_client_created_idx`: benchmark/client cohort reads.
- `job_events_job_cursor_idx`: job timeline.
- `workers_last_seen_idx`: fleet health.
- `idempotency_expiry_idx`: future retention maintenance.

This workload is update-heavy. Production operation must monitor dead tuples, autovacuum progress, transaction age, table/index bloat, lock waits, and query plans.

## Consistency limits

- Exactly-once delivery is impossible at the QueueForge/external-effect boundary without cooperation from the effect sink.
- A single PostgreSQL primary is a v1 availability dependency.
- Worker network partitions look like worker crashes after the lease deadline.
- An uncertain database commit must be resolved by reading job state before retrying settlement; the current client retries through redelivery rather than guessing success.
- Server-sent events are convenience, not durable delivery. Clients refetch snapshots.
