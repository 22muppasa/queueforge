# QueueForge benchmark results

**Verdict:** PASS  
**Batch:** `bench-20260905163211566`  
**Measured:** 2026-09-05T16:32:11.567Z to 2026-09-05T16:35:28.460Z  
**Topology:** one API, three workers × four slots, PostgreSQL 17.6, k6 2.0.0; all containers on this single Windows/WSL2 host.

## Published measurements

Each point is three open-loop, constant-arrival-rate trials. Values are medians; parentheses show the min–max range. Every accepted job is checked against PostgreSQL after a full queue drain.

| Offered rate | Valid trials | Admission RPS | Submit p95 | Submit p99 | Completed/s | Queue wait p95 | End-to-end p95 | Peak backlog |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50/s | 3/3 | 50.1 (50.0–50.1) | 6.3 ms (6.2–7.5) | 8.2 ms (8.0–9.3) | 49.6 (49.6–50.0) | 98.4 ms (97.5–99.1) | 108.9 ms (107.6–109.3) | 5 |
| 150/s | 3/3 | 150.0 (150.0–150.0) | 6.2 ms (6.0–7.4) | 9.4 ms (7.9–11.7) | 109.5 (108.5–109.8) | 3519.0 ms (3516.5–3611.0) | 3524.9 ms (3523.0–3621.3) | 378 |
| 300/s | 3/3 | 299.9 (299.9–300.0) | 8.0 ms (7.9–9.2) | 12.9 ms (11.3–21.5) | 107.1 (107.1–108.6) | 17036.1 ms (16700.0–17172.6) | 17047.3 ms (16709.0–17179.0) | 1789 |

## Trial ledger

| Run | Offered | Accepted | Dropped | HTTP failures | Checks | Drain after injection | Valid |
|---|---:|---:|---:|---:|---:|---:|---|
| `bench-20260905163211566-r50-t1` | 50/s | 500 | 0 | 0.000% | 100.000% | 7 ms | PASS |
| `bench-20260905163211566-r150-t1` | 150/s | 1500 | 0 | 0.000% | 100.000% | 2788 ms | PASS |
| `bench-20260905163211566-r300-t1` | 300/s | 3001 | 0 | 0.000% | 100.000% | 16570 ms | PASS |
| `bench-20260905163211566-r150-t2` | 150/s | 1500 | 0 | 0.000% | 100.000% | 2508 ms | PASS |
| `bench-20260905163211566-r300-t2` | 300/s | 3000 | 0 | 0.000% | 100.000% | 16952 ms | PASS |
| `bench-20260905163211566-r50-t2` | 50/s | 501 | 0 | 0.000% | 100.000% | 7 ms | PASS |
| `bench-20260905163211566-r300-t3` | 300/s | 3001 | 0 | 0.000% | 100.000% | 16650 ms | PASS |
| `bench-20260905163211566-r50-t3` | 50/s | 501 | 0 | 0.000% | 100.000% | 10 ms | PASS |
| `bench-20260905163211566-r150-t3` | 150/s | 1500 | 0 | 0.000% | 100.000% | 2465 ms | PASS |

## Interpretation

All correctness checks remained valid through the highest offered rate, **300 jobs/s**. The highest tested point that kept completion near the offered rate without material backlog was **50 jobs/s**. The overloaded points observed roughly **107–109 completed jobs/s**. These are tested points, not a claim of a precise maximum; the gap between 50 and 150 jobs/s remains explicit. The handler is a zero-work durable no-op, so the results primarily measure API, transaction, claim, and acknowledgement overhead.

## Methodology and limits

- Warm-up: 25/s for 5s; excluded from aggregates.
- Formal matrix: 50, 150, 300 jobs/s × 3 repetitions × 10s. Trial order is rotated by repetition.
- Generator: k6 constant-arrival-rate, unique idempotency key per job, fixed VU allocation, no iteration sleep.
- Validity: zero dropped iterations and HTTP failures; all response contract checks pass; k6/database counts match; every job has one attempt and submitted/claimed/succeeded event; no retry, lease-expiry, DLQ, cancellation, or container restart.
- Limits: single developer machine, local Docker bridge, no TLS/auth/WAN latency, a zero-work handler, and a generator sharing the same Docker/WSL2 resource pool. Do not extrapolate these figures to production.

## Environment

```text
Host: win32 10.0.26200; 16 logical CPUs; 31.46 GiB RAM
Docker: 29.5.2
Compose: Docker Compose version v5.1.4
PostgreSQL: 17.6
Node: v22.22.3
Git revision: uncommitted local artifact
Database settings: max_connections=100, shared_buffers=128MB
```

Raw k6 summaries, per-trial server truth, queue samples, resource samples, and command arguments are retained in [`evidence/raw`](./raw/).
