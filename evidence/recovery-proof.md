# QueueForge crash-recovery evidence

**Verdict:** PASS
**Run:** `recovery-20260905163027421`  
**Started:** 2026-09-05T16:30:27.422Z  
**Finished:** 2026-09-05T16:31:11.989Z  
**Duration:** 44567 ms

## What was proved

| Scenario | Evidence |
|---|---|
| Crash after durable effect | Worker `worker-a` was hard-killed; job recovered in 15048 ms; two executions produced one durable effect. |
| Crash before effect | A different worker `worker-b` was hard-killed; the surviving worker completed attempt 2 and produced one effect. |
| Submission idempotency | 20 concurrent requests resolved to 1 job (1 accepted, 19 replayed); conflicting reuse returned 409. |
| Retry + DLQ + redrive | Poison job made 3 attempts, entered the DLQ, and redrive remained idempotent without mutating the source. |
| Cancellation | Running job reached `cancelled`. |
| Persistence | API container restart retained 2 attempts and 6 events. |

## Assertions

| Result | Assertion | Detail |
|---|---|---|
| PASS | twenty concurrent identical requests create exactly one job | `{"status_counts":{"200":19,"202":1},"unique_job_ids":1}` |
| PASS | same key with different intent is rejected | `{"status":409,"problem":"https://queueforge.dev/problems/idempotency-conflict"}` |
| PASS | scheduled idempotency probe is cleaned up by cancellation | `{"status":200,"job_status":"cancelled"}` |
| PASS | isolated store-level test rejects stale settlement after lease generation changes | `{"test":"stale lease fencing","result":"passed"}` |
| PASS | temporary fencing-test database is removed | `{"database_hash_suffix":"905163027421"}` |
| PASS | after-effect crash job is accepted | `{"status":202}` |
| PASS | kill target worker-a belongs to the QueueForge Compose project | `{"com.docker.compose.config-hash":"a4a1e6714805fca2556bccc62678c76906254e6a69f9e96bbae1ab1f552adb54","com.docker.compose.container-number":"1","com.docker.compose.depends_on":"postgres:service_healthy:false","com.docker.compose.image":"sha256:efe2b23b2b1207dd470dac699900b38d345dbec3f0f22ed2c3ff3db098196c83","com.docker.compose.oneoff":"False","com.docker.compose.project":"queueforge","com.docker.compose.project.config_files":"C:\\Users\\sasha\\Documents\\Codex\\2026-09-05\\plan-the-following-out-very-very\\outputs\\queueforge\\docker-compose.yml","com.docker.compose.project.working_dir":"C:\\Users\\sasha\\Documents\\Codex\\2026-09-05\\plan-the-following-out-very-very\\outputs\\queueforge","com.docker.compose.replace":"queueforge-worker-a","com.docker.compose.service":"worker-a","com.docker.compose.version":"5.1.4"}` |
| PASS | hard kill of worker-a exits with SIGKILL semantics | `{"status":"exited","exit_code":137,"oom_killed":false}` |
| PASS | hard-killed attempt is durably marked lease_expired | `{"job_id":"cdd66055-4a2f-4b5f-bdc0-0df75238f6f4","attempt_no":1,"lease_generation":"1","worker_id":"8a7de0df-332e-4383-87e7-b7ed2905393c","worker_name":"worker-a","claimed_at":"2026-09-05T16:30:31.119Z","last_heartbeat_at":"2026-09-05T16:30:31.119Z","finished_at":"2026-09-05T16:30:37.126Z","outcome":"lease_expired","error_type":"LeaseExpired","error_message":"Worker stopped heartbeating before the lease deadline","next_available_at":"2026-09-05T16:30:37.195Z","raw_backoff_ms":100,"backoff_ms":67,"duration_ms":6007.333}` |
| PASS | a replacement attempt succeeds | `[{"job_id":"cdd66055-4a2f-4b5f-bdc0-0df75238f6f4","attempt_no":1,"lease_generation":"1","worker_id":"8a7de0df-332e-4383-87e7-b7ed2905393c","worker_name":"worker-a","claimed_at":"2026-09-05T16:30:31.119Z","last_heartbeat_at":"2026-09-05T16:30:31.119Z","finished_at":"2026-09-05T16:30:37.126Z","outcome":"lease_expired","error_type":"LeaseExpired","error_message":"Worker stopped heartbeating before the lease deadline","next_available_at":"2026-09-05T16:30:37.195Z","raw_backoff_ms":100,"backoff_ms":67,"duration_ms":6007.333},{"job_id":"cdd66055-4a2f-4b5f-bdc0-0df75238f6f4","attempt_no":2,"lease_generation":"2","worker_id":"2504d18c-097f-44f0-8b06-76ccc026a21d","worker_name":"worker-b","claimed_at":"2026-09-05T16:30:37.213Z","last_heartbeat_at":"2026-09-05T16:30:46.222Z","finished_at":"2026-09-05T16:30:46.223Z","outcome":"succeeded","error_type":null,"error_message":null,"next_available_at":null,"raw_backoff_ms":null,"backoff_ms":null,"duration_ms":9010.011}]` |
| PASS | replacement is fenced by a newer generation | `{"killed_generation":"1","replacement_generation":"2"}` |
| PASS | replacement uses another worker incarnation | `{"killed_worker_id":"8a7de0df-332e-4383-87e7-b7ed2905393c","replacement_worker_id":"2504d18c-097f-44f0-8b06-76ccc026a21d"}` |
| PASS | the handler executed twice but its durable logical effect occurred once | `{"visits":2,"logical_effect_count":1}` |
| PASS | audit events prove claim-expiry-retry-reclaim-success order | `{"event_types":["submitted","claimed","lease_expired","retry_scheduled","claimed","succeeded"]}` |
| PASS | recovery finishes within the documented 40 second bound | `{"recovery_ms":15048}` |
| PASS | before-effect crash job is accepted | `{"status":202}` |
| PASS | second hard kill targets a different worker service | `{"first_service":"worker-a","second_service":"worker-b"}` |
| PASS | kill target worker-b belongs to the QueueForge Compose project | `{"com.docker.compose.config-hash":"a2a6fe953f9c839a6ff6f8b78235ffa3a9c242feeff72637f91401ad509f35c3","com.docker.compose.container-number":"1","com.docker.compose.depends_on":"postgres:service_healthy:false","com.docker.compose.image":"sha256:c8400b2d00e8d10a2dbaf295d9abf31abe75eb89a5bf2057cb640652ccfe25bb","com.docker.compose.oneoff":"False","com.docker.compose.project":"queueforge","com.docker.compose.project.config_files":"C:\\Users\\sasha\\Documents\\Codex\\2026-09-05\\plan-the-following-out-very-very\\outputs\\queueforge\\docker-compose.yml","com.docker.compose.project.working_dir":"C:\\Users\\sasha\\Documents\\Codex\\2026-09-05\\plan-the-following-out-very-very\\outputs\\queueforge","com.docker.compose.replace":"queueforge-worker-b","com.docker.compose.service":"worker-b","com.docker.compose.version":"5.1.4"}` |
| PASS | hard kill of worker-b exits with SIGKILL semantics | `{"status":"exited","exit_code":137,"oom_killed":false}` |
| PASS | pre-effect killed attempt expires and replacement succeeds | `[{"job_id":"ace8db89-90f2-47fc-96c2-b582a8b3bc9b","attempt_no":1,"lease_generation":"1","worker_id":"2504d18c-097f-44f0-8b06-76ccc026a21d","worker_name":"worker-b","claimed_at":"2026-09-05T16:30:48.402Z","last_heartbeat_at":"2026-09-05T16:30:48.402Z","finished_at":"2026-09-05T16:30:54.513Z","outcome":"lease_expired","error_type":"LeaseExpired","error_message":"Worker stopped heartbeating before the lease deadline","next_available_at":"2026-09-05T16:30:54.579Z","raw_backoff_ms":100,"backoff_ms":62,"duration_ms":6111.314},{"job_id":"ace8db89-90f2-47fc-96c2-b582a8b3bc9b","attempt_no":2,"lease_generation":"2","worker_id":"8ff06ec0-049d-48fe-a745-d06847e96caf","worker_name":"worker-c","claimed_at":"2026-09-05T16:30:54.628Z","last_heartbeat_at":"2026-09-05T16:31:03.634Z","finished_at":"2026-09-05T16:31:03.644Z","outcome":"succeeded","error_type":null,"error_message":null,"next_available_at":null,"raw_backoff_ms":null,"backoff_ms":null,"duration_ms":9015.525}]` |
| PASS | effect delayed until the replacement attempt is still applied once | `{"effect":{"job_id":"ace8db89-90f2-47fc-96c2-b582a8b3bc9b","effect_key":"recovery-20260905163027421-before","value":1,"first_attempt":2,"first_worker_id":"8ff06ec0-049d-48fe-a745-d06847e96caf","created_at":"2026-09-05T16:31:03.634Z"},"visits":[{"job_id":"ace8db89-90f2-47fc-96c2-b582a8b3bc9b","attempt_no":2,"worker_id":"8ff06ec0-049d-48fe-a745-d06847e96caf","worker_name":"worker-c","visited_at":"2026-09-05T16:31:03.633Z"}],"logicalEffectCount":1}` |
| PASS | poison job is accepted | `{"status":202}` |
| PASS | poison job consumes exactly its three allowed attempts | `[{"job_id":"8ce6bd0f-ed98-4c2c-8709-75ac5b1f44cd","attempt_no":1,"lease_generation":"1","worker_id":"8f989735-439e-4d04-a17f-459a7c6472cb","worker_name":"worker-a","claimed_at":"2026-09-05T16:31:05.219Z","last_heartbeat_at":"2026-09-05T16:31:05.219Z","finished_at":"2026-09-05T16:31:05.231Z","outcome":"retryable_failure","error_type":"RetryableJobError","error_message":"proof poison job","next_available_at":"2026-09-05T16:31:05.260Z","raw_backoff_ms":50,"backoff_ms":29,"duration_ms":11.409},{"job_id":"8ce6bd0f-ed98-4c2c-8709-75ac5b1f44cd","attempt_no":2,"lease_generation":"2","worker_id":"8ff06ec0-049d-48fe-a745-d06847e96caf","worker_name":"worker-c","claimed_at":"2026-09-05T16:31:05.324Z","last_heartbeat_at":"2026-09-05T16:31:05.324Z","finished_at":"2026-09-05T16:31:05.329Z","outcome":"retryable_failure","error_type":"RetryableJobError","error_message":"proof poison job","next_available_at":"2026-09-05T16:31:05.397Z","raw_backoff_ms":100,"backoff_ms":68,"duration_ms":4.682},{"job_id":"8ce6bd0f-ed98-4c2c-8709-75ac5b1f44cd","attempt_no":3,"lease_generation":"3","worker_id":"8f989735-439e-4d04-a17f-459a7c6472cb","worker_name":"worker-a","claimed_at":"2026-09-05T16:31:05.430Z","last_heartbeat_at":"2026-09-05T16:31:05.430Z","finished_at":"2026-09-05T16:31:05.437Z","outcome":"retryable_failure","error_type":"RetryableJobError","error_message":"proof poison job","next_available_at":null,"raw_backoff_ms":null,"backoff_ms":null,"duration_ms":7.011}]` |
| PASS | poison job schedules two retries before DLQ | `{"event_types":["submitted","claimed","retry_scheduled","claimed","retry_scheduled","claimed","dead_lettered"]}` |
| PASS | DLQ exposes the terminal source job | `{"status":200,"source_job_id":"8ce6bd0f-ed98-4c2c-8709-75ac5b1f44cd"}` |
| PASS | redrive creates a different immutable job | `{"status":202,"source":"8ce6bd0f-ed98-4c2c-8709-75ac5b1f44cd","destination":"7657c6fd-3a74-469b-9324-86e24e01a8e7"}` |
| PASS | redrive request is itself idempotent | `{"status":200,"first":"7657c6fd-3a74-469b-9324-86e24e01a8e7","replay":"7657c6fd-3a74-469b-9324-86e24e01a8e7"}` |
| PASS | redrive preserves the original DLQ record | `{"status":"dead_lettered"}` |
| PASS | running cancellation is acknowledged asynchronously | `{"status":202}` |
| PASS | running handler cooperatively reaches cancelled | `[{"job_id":"67f3ccac-3755-402f-9a06-83a3a860a358","attempt_no":1,"lease_generation":"1","worker_id":"8ff06ec0-049d-48fe-a745-d06847e96caf","worker_name":"worker-c","claimed_at":"2026-09-05T16:31:05.945Z","last_heartbeat_at":"2026-09-05T16:31:07.752Z","finished_at":"2026-09-05T16:31:07.756Z","outcome":"cancelled","error_type":null,"error_message":null,"next_available_at":null,"raw_backoff_ms":null,"backoff_ms":null,"duration_ms":1810.369}]` |
| PASS | API restart preserves job, attempts, events, and result in PostgreSQL | `{"before":{"status":"succeeded","attempts":2,"events":6},"after":{"status":"succeeded","attempts":2,"events":6}}` |

## Recovery timeline

The first crash is intentionally placed after the demo handler commits its business effect but before QueueForge acknowledges success. The lease expires, another worker obtains a strictly newer generation, and the unique `demo_effects(job_id)` guard prevents a duplicated logical effect even though the handler is delivered twice.

Machine-readable evidence: [recovery-proof.json](./recovery-proof.json)

## Environment

```text
29.5.2
Docker Compose version v5.1.4
NAME                    IMAGE                  COMMAND                  SERVICE    CREATED         STATUS                   PORTS
queueforge-api          queueforge-api         "node dist/index.js …"   api        3 minutes ago   Up 3 seconds             127.0.0.1:18080->8080/tcp
queueforge-postgres-1   postgres:17.6-alpine   "docker-entrypoint.s…"   postgres   7 minutes ago   Up 7 minutes (healthy)   127.0.0.1:54329->5432/tcp
queueforge-worker-a     queueforge-worker-a    "node dist/index.js …"   worker-a   3 minutes ago   Up 7 seconds             
queueforge-worker-b     queueforge-worker-b    "node dist/index.js …"   worker-b   3 minutes ago   Up 7 seconds             
queueforge-worker-c     queueforge-worker-c    "node dist/index.js …"   worker-c   3 minutes ago   Up About a minute
```

