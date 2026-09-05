# HTTP API reference

Base URL in the supplied stack: `http://localhost:18080`.

All bodies are JSON. Validation errors and conflicts use `application/problem+json` with `type`, `title`, `status`, `detail`, request `instance`, and `request_id`.

## Common headers

| Header | Use |
|---|---|
| `Content-Type: application/json` | Required for JSON submissions. |
| `X-Client-Id` | Optional idempotency scope; defaults to `public`. Pattern: alphanumeric first, then alphanumeric/`.`/`_`/`-`, maximum 128. This is not authentication. |
| `Idempotency-Key` | Optional on submission, required on redrive. Maximum 255 visible characters. |

## Submit

`POST /v1/jobs`

```json
{
  "queue": "default",
  "type": "noop",
  "payload": { "duration_ms": 25 },
  "priority": 0,
  "available_at": "2026-09-05T18:00:00.000Z",
  "max_attempts": 5,
  "timeout_ms": 300000,
  "backoff_base_ms": 500,
  "backoff_cap_ms": 60000
}
```

Fields:

| Field | Default | Bounds/meaning |
|---|---:|---|
| `queue` | `default` | 1–64 safe name characters. |
| `type` | — | One of `noop`, `flaky`, `always_fail`, `idempotent_counter`. |
| `payload` | `{}` | Handler-specific object; total HTTP body limit 256 KiB. |
| `priority` | `0` | Integer −100 through 100; higher claims first. |
| `available_at` | now | ISO timestamp with offset, at most one year ahead. |
| `max_attempts` | `5` | 1–100, initial execution included. |
| `timeout_ms` | `300000` | 100–3,600,000. |
| `backoff_base_ms` | `500` | 1–3,600,000. |
| `backoff_cap_ms` | `60000` | Base through 86,400,000. |

Fresh response: `202 Accepted`, `Location: /v1/jobs/:id`, `Idempotency-Replayed: false`.

Identical key replay: `200 OK`, same location/job, `Idempotency-Replayed: true`.

Conflicting key reuse: `409` with problem type `.../idempotency-conflict` and `errors.existing_job_id`.

## List jobs

`GET /v1/jobs?status=running&queue=critical&type=noop&limit=50&cursor=...`

Maximum page size is 200. Results sort by `(created_at, id)` descending. `meta.next_cursor` is opaque and may be passed unchanged.

## Job detail

`GET /v1/jobs/:id`

Returns the public job plus ordered `attempts` and ordered durable `events`. The secret lease token is never returned.

## Events

`GET /v1/jobs/:id/events?after_id=0&limit=200`

Use the last monotonic event ID as `after_id`. Maximum 500.

## Cancel

`POST /v1/jobs/:id/cancel`

- Ready job: `200`, `meta.outcome = cancelled`.
- Running job: `202`, `meta.outcome = requested`; handler stops cooperatively on heartbeat.
- Terminal job: `200`, `meta.outcome = terminal`; no mutation.

## Dead letters and redrive

`GET /v1/dead-letters?limit=100`

`POST /v1/dead-letters/:jobId/redrive` with `Idempotency-Key`.

Redrive returns a new linked job. The same source/client/key replays that destination. A non-DLQ source returns `409`.

## Workers

`GET /v1/workers`

Returns every worker incarnation with name, host, PID, queues, concurrency, busy slots, build, timestamps, derived status, and heartbeat age. Old rows may remain; consumers should choose recent active incarnations.

## Dashboard

`GET /v1/dashboard/summary` provides current ready/scheduled/running/retry/DLQ/terminal counts, one- and five-minute rates, recent latency percentiles, online/busy workers, server time, and a 15-minute completion timeline.

`GET /v1/dashboard/events` is a server-sent event stream of snapshots every two seconds. It is not a replacement for durable polling.

## Benchmark cohort

`GET /v1/benchmarks/:runId`

This operator endpoint aggregates jobs whose `client_id` equals `runId`: terminal counts, queue/execution/end-to-end percentiles, attempts, transition cardinalities, and idempotency cardinalities. Run IDs are bounded safe names.

## Demo effects

`GET /v1/demo/effects/:jobId` returns the unique effect row, attempt visits, and `logicalEffectCount`. It exists to make crash-after-effect-before-ack observable.

## Health and metrics

- `/health/live` means the API process can answer.
- `/health/ready` verifies a database query and returns `503` when unavailable.
- `/metrics` exposes HTTP request counters/histograms and queue/worker gauges in Prometheus text format.

Metric labels are bounded route/method/status values. Job IDs, client IDs, idempotency keys, and error messages are never metric labels.

## Status codes

| Code | Meaning |
|---:|---|
| 200 | Read, replay, immediate cancel, or terminal no-op. |
| 202 | New durable submission, running cancel request, or new redrive. |
| 400 | Request/header/query validation. |
| 404 | Job not found. |
| 409 | Idempotency conflict or invalid transition. |
| 413 | Body exceeds 256 KiB. |
| 503 | Readiness database check failed. |
