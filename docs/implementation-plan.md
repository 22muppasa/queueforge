# Implementation plan and completion map

This document records the plan used to turn QueueForge from an idea into the supplied tested artifact, plus the path from this educational v1 to a production service.

## Phase 0 — define truth and failure semantics

Status: complete.

Acceptance criteria:

- State plainly that delivery is at least once.
- Separate submission idempotency, queue-state fencing, and handler-effect idempotency.
- Define terminal states, attempts, lease expiry, cancellation races, retry formula, redrive semantics, and non-goals before choosing UI/framework details.
- Use database time for ownership.

## Phase 1 — durable data model

Status: complete.

Delivered jobs, idempotency reservations, attempts, events, workers, dead letters, redrives, demo effects, and demo visits with checks and partial indexes.

Completion checks:

- Running/non-running lease-field constraints.
- Terminal timestamp constraint.
- Bounded attempts/timeouts/backoff.
- Unique attempt token and job/attempt key.
- Unique effect per job.
- Query-aligned ready/expired indexes.

## Phase 2 — transactional queue core

Status: complete.

Delivered atomic submission/fingerprint handling, multi-consumer claim with `SKIP LOCKED`, free-slot-only claiming, token+generation fencing, heartbeat, success/failure settlement, capped full-jitter retry, reaping, DLQ, cancel, and immutable redrive.

Exit evidence: eight isolated unit/integration tests pass, including 100 jobs claimed by 10 concurrent consumers and stale generation rejection.

## Phase 3 — worker runtime and handlers

Status: complete.

Delivered process-incarnation registration, independent loops, fixed concurrency, heartbeat-driven abort, timeouts, failure classification, graceful drain deadline, structured logs, and four safe allowlisted handlers.

## Phase 4 — API and observability

Status: complete for local v1.

Delivered bounded Zod validation, RFC-style problem bodies, location/replay headers, job/event/worker/DLQ/dashboard routes, SSE summaries, liveness/readiness, and Prometheus metrics.

Production gap: authentication, authorization, quotas, rate limits, richer tracing, and cached/materialized dashboard aggregates.

## Phase 5 — operations dashboard

Status: complete.

Delivered responsive desktop/mobile operations UI with live/demo connection state, metrics, timeline, job ledger/detail, workers, retries, DLQ/redrive, submit, cancel, and a crash-lab explanation. Social metadata and a generated 1200×630 preview are included.

## Phase 6 — deterministic failure proof

Status: complete.

Delivered an automated harness covering concurrent idempotency, direct stale fencing, two distinct SIGKILL windows, retry/DLQ/redrive, cancellation, API restart persistence, machine-readable evidence, and cleanup.

Exit evidence: 31/31 assertions passed; two different workers exited 137; replacement generations succeeded; two post-effect executions produced one logical effect.

## Phase 7 — load measurement

Status: complete for a local baseline.

Delivered pinned k6, open-loop fixed-rate injection, warm-up, rotated three-run matrix, cohort-specific database aggregates, full drain, resource snapshots, restart checks, raw outputs, and median/range publication.

Exit evidence: nine valid trials, zero generator drops/HTTP failures/restarts, exact database cardinalities. Admission reached tested 300/s; execution saturated around 107–109 zero-work jobs/s.

## Phase 8 — safety and reproducibility

Status: complete for the artifact.

- Host ports bind to localhost.
- Backend and dashboard dependency audits report zero known vulnerabilities at delivery.
- Containers run the application as a nonroot user.
- Integration tests use a disposable database.
- Build/test/lint commands and raw evidence are retained.
- No destructive volume cleanup is automated.

## Phase 9 — production hardening backlog

Priority 0:

- Authentication and explicit tenant authorization for every job/operator route.
- Secret manager, TLS termination, security headers, CORS allowlist, and request rate/size quotas.
- PostgreSQL HA, encrypted backup/PITR, restore drills, connection proxy/budget, and alerts.
- Handler-side transactional outbox/inbox or downstream idempotency/fencing contract.
- Payload/result/error redaction, encryption classification, and retention jobs.

Priority 1:

- Worker handler/schema capability registration for rolling deploys.
- Graceful release outcome for jobs that exceed the drain deadline.
- Separate heartbeat pool/reserved connections.
- PostgreSQL notification as a wake-up hint while preserving polling correctness.
- Queue pause, per-queue concurrency/rate limits, priority aging/weighted fairness.
- Batch submit/status, operator authorization, DLQ bulk-redrive throttling.
- OpenTelemetry producer/process spans and trace propagation.
- Materialized/recent-window observability aggregates to protect the primary under large history.

Priority 2:

- Scheduled/recurring jobs, uniqueness windows, workflows/DAGs, result object storage.
- Handler isolation for CPU-bound/untrusted workloads.
- Partitioning/archival, online schema migrations, chaos tests for DB/network partitions.
- Dedicated benchmark hosts, longer steady-state tests, scaling curves by worker count, mixed/retry workloads, and dashboard-overhead comparisons.

## Production go-live gates

Do not call the service production-ready until:

1. Threat model and tenant authorization are reviewed.
2. Every handler documents idempotency and cancellation behavior.
3. Capacity tests cover realistic payloads, effects, downstream latency, and failure rates for at least the expected peak plus headroom.
4. Backup restore, database failover, worker/network partition, deploy rollback, and retry-storm exercises pass.
5. SLOs and alerts exist for admission, queue wait, end-to-end completion, loss/duplicates at the effect boundary, DLQ, and oldest ready age.
6. Retention/erasure requirements are implemented without violating idempotency/audit obligations.
7. On-call runbooks are exercised by someone other than the author.
