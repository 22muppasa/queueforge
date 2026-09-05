# Operations runbook

## Topology and configuration

The default Compose stack is one API, PostgreSQL 17.6, and three workers with four slots each. Services share the `queueforge` bridge network. Host access is local-only on API port 18080 and PostgreSQL port 54329.

| Variable | Default in Compose | Guidance |
|---|---:|---|
| `DATABASE_URL` | local Compose URL | Use a secret manager outside development. |
| `DATABASE_POOL_SIZE` | 12 | Budget API + every worker below PostgreSQL connection capacity. |
| `WORKER_NAME` | service-specific | Human label; UUID incarnation remains identity. |
| `WORKER_QUEUES` | `default,critical,media` | Comma-separated allowlist. |
| `WORKER_CONCURRENCY` | 4 | Start low; tune against handler/database behavior. |
| `LEASE_MS` | 6000 | Short for demonstrations. Production should exceed normal heartbeat/database jitter. |
| `HEARTBEAT_MS` | 1800 | Must be below lease; roughly lease/3 is a useful starting point. |
| `CLAIM_POLL_MS` | 100 | Correctness uses polling; lower costs more database work. |
| `REAPER_POLL_MS` | 250 | Bounds local expiry observation, not exact recovery time. |
| `WORKER_OFFLINE_MS` | 5000 | Fleet display threshold. |
| `BUILD_VERSION` | `local` | Set a release SHA/tag. |
| `LOG_LEVEL` | `info` | Structured JSON on stdout. |
| `CORS_ORIGIN` | `*` | Restrict before nonlocal deployment. |

The demo lease is intentionally aggressive. A production baseline might use a 30-second lease, 10-second heartbeat, and a reaper interval chosen from recovery goals and database load.

## Start, inspect, stop

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api worker-a worker-b worker-c
docker compose stop
```

Do not use `down -v` during normal operation. The named `queueforge-data` volume contains the durable ledger.

## Readiness gates

Before routing traffic:

1. Require PostgreSQL health.
2. Require `/health/ready` HTTP 200 with `database: connected`.
3. Require the expected worker names to have recent active incarnations.
4. Confirm every intended queue has at least one consumer.
5. Confirm no migration process is failing.

Liveness should restart a wedged API process. Readiness should remove it from traffic while PostgreSQL is unavailable.

## Observability

### Logs

Every record is JSON with timestamp, severity, event, service, and contextual IDs. Useful events include:

- `worker_started`, `worker_draining`, `worker_stopped`
- `job_started`, `job_succeeded`, `job_failed`
- `job_heartbeat_failed`, `job_settlement_rejected`
- `expired_leases_recovered`
- `demo_effect_observed`

Avoid logging payloads or idempotency keys. Forward logs to a bounded-retention system and control access.

### Metrics and alerts

Scrape `/metrics`. Alert candidates:

- Readiness failures or PostgreSQL connection saturation.
- Ready depth/oldest age above SLO for several windows.
- No online consumer for a nonempty queue.
- Lease expiration rate above baseline.
- DLQ growth.
- Retry rate spike.
- Submit/error latency histogram degradation.
- PostgreSQL lock waits, dead tuples, disk, WAL/replication lag, and transaction age.

Histograms should use buckets matched to SLOs. Never label metrics with job IDs, client IDs, raw queue payload fields, or error messages.

## Worker loss

Expected behavior:

1. Worker heartbeats stop.
2. Its current job leases expire according to database time.
3. Any surviving worker’s reaper locks each expired row.
4. The attempt closes as `lease_expired`.
5. The job is cancelled, retried with jitter, or dead-lettered based on durable policy.
6. A replacement claim gets a new token and higher generation.

Investigate unexpected lease loss by checking database latency, pool starvation, event-loop blocking, CPU throttling, GC pauses, network loss, and handler code that does not yield.

## Queue backlog

1. Compare admission rate with completed/s. Low submit latency can coexist with an overloaded execution plane.
2. Inspect ready vs scheduled vs retry-wait.
3. Check worker online/busy slots and queue subscriptions.
4. Inspect job types/durations and retry concentration.
5. Add workers or slots only after checking database connection and lock capacity.
6. Consider per-queue isolation and admission rate limits.

Scale-out improves I/O work until PostgreSQL, downstream dependencies, or connection pools saturate. CPU-bound handlers should use separate processes/services instead of blocking the Node event loop.

## Retry storm

- Confirm backoff cap and max attempts are bounded.
- Full jitter should spread `available_at` timestamps.
- Rate-limit redrives and client submissions.
- Quarantine a poison type or pause its consumers.
- Repair the dependency before bulk redrive.

## DLQ response

1. Group by safe error type/job type; do not expose raw sensitive payloads.
2. Identify permanent validation/code errors vs exhausted transient failures.
3. Fix the cause.
4. Redrive a small canary with a unique idempotency key.
5. Confirm success and backlog behavior.
6. Throttle any bulk redrive.

The source record is immutable. Retention/archival should preserve the redrive relation and idempotency policy.

## Database outage

- API readiness returns 503; liveness may remain healthy.
- Workers cannot safely claim or renew. After connectivity exceeds the lease, they must assume ownership is lost and discard results rejected by fencing.
- Do not relax the expiry predicate to make recovery “easier.” That permits split brain.
- Restore PostgreSQL, check transaction/replication integrity, let reapers recover expired attempts, then watch retries/downstreams.

## Backup and restore

Production operation needs scheduled base backups/snapshots, WAL point-in-time recovery, restore drills, encryption, and retained idempotency/DLQ/event data according to policy. A backup that has never been restored is not verified.

After restore, start PostgreSQL before workers, verify migrations, inspect any previously running rows, then start a small worker cohort and observe reaping.

## Rolling deployment

This v1 assumes all workers understand all allowlisted handlers and payload schema version 1. For heterogeneous rolling deploys, add worker capability/version registration and filter claim candidates so an older worker cannot claim a newer payload schema.

Suggested order:

1. Add backward-compatible schema.
2. Deploy API capable of old/new formats.
3. Deploy new workers and confirm registry capability.
4. Start submitting new version.
5. Remove old capability only after all older work drains.

## Retention maintenance

The schema records idempotency expiry but v1 does not automatically delete history. A production retention job must define independent windows for results, events, attempts, worker incarnations, DLQ, and idempotency tombstones. Never delete a key before the published idempotency window, and do not orphan audit/redrive relationships.
