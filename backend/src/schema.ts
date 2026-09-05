export const schemaSql = String.raw`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  client_id text NOT NULL DEFAULT 'public' CHECK (length(client_id) BETWEEN 1 AND 128),
  queue text NOT NULL CHECK (queue ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'),
  type text NOT NULL CHECK (type ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_schema_version integer NOT NULL DEFAULT 1 CHECK (payload_schema_version >= 1),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'dead_lettered', 'cancelled')),
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts_started integer NOT NULL DEFAULT 0 CHECK (attempts_started >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  timeout_ms integer NOT NULL DEFAULT 300000 CHECK (timeout_ms BETWEEN 100 AND 3600000),
  backoff_base_ms integer NOT NULL DEFAULT 500 CHECK (backoff_base_ms BETWEEN 1 AND 3600000),
  backoff_cap_ms integer NOT NULL DEFAULT 60000 CHECK (backoff_cap_ms BETWEEN backoff_base_ms AND 86400000),
  lease_owner uuid,
  lease_token uuid,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  first_started_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  last_error jsonb,
  redrive_of_job_id uuid REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision bigint NOT NULL DEFAULT 0,
  CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND last_heartbeat_at IS NOT NULL)
    OR
    (status <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND last_heartbeat_at IS NULL)
  ),
  CHECK (
    (status IN ('succeeded', 'dead_lettered', 'cancelled') AND finished_at IS NOT NULL)
    OR
    (status NOT IN ('succeeded', 'dead_lettered', 'cancelled') AND finished_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  client_id text NOT NULL,
  operation text NOT NULL,
  key_hash char(64) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (client_id, operation, key_hash),
  UNIQUE (job_id)
);

CREATE TABLE IF NOT EXISTS job_attempts (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  lease_token uuid NOT NULL UNIQUE,
  lease_generation bigint NOT NULL CHECK (lease_generation >= 1),
  worker_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded', 'retryable_failure', 'permanent_failure', 'timed_out', 'lease_expired', 'cancelled', 'worker_shutdown')),
  error_type text,
  error_message text,
  next_available_at timestamptz,
  raw_backoff_ms integer,
  backoff_ms integer,
  duration_ms double precision,
  PRIMARY KEY (job_id, attempt_no),
  CHECK ((outcome IS NULL AND finished_at IS NULL) OR (outcome IS NOT NULL AND finished_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  type text NOT NULL,
  from_status text,
  to_status text,
  attempt_no integer,
  worker_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS workers (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  hostname text NOT NULL,
  pid integer NOT NULL,
  queues text[] NOT NULL,
  concurrency integer NOT NULL CHECK (concurrency BETWEEN 1 AND 256),
  status text NOT NULL CHECK (status IN ('active', 'draining', 'stopped')),
  current_jobs integer NOT NULL DEFAULT 0 CHECK (current_jobs >= 0),
  build_version text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS dead_letters (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  reason text NOT NULL,
  final_attempt integer NOT NULL,
  error_snapshot jsonb,
  dead_lettered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS job_redrives (
  source_job_id uuid NOT NULL REFERENCES jobs(id),
  destination_job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_job_id, destination_job_id)
);

CREATE TABLE IF NOT EXISTS demo_effects (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  effect_key text NOT NULL,
  value integer NOT NULL,
  first_attempt integer NOT NULL,
  first_worker_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS demo_attempt_visits (
  job_id uuid NOT NULL REFERENCES jobs(id),
  attempt_no integer NOT NULL,
  worker_id uuid NOT NULL,
  visited_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (queue, priority DESC, available_at, created_at, id)
  WHERE status IN ('queued', 'retry_wait');
CREATE INDEX IF NOT EXISTS jobs_expired_lease_idx ON jobs (lease_expires_at, id)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs (status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_client_created_idx ON jobs (client_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS job_events_job_cursor_idx ON job_events (job_id, id);
CREATE INDEX IF NOT EXISTS job_events_recent_idx ON job_events (occurred_at DESC, type);
CREATE INDEX IF NOT EXISTS workers_last_seen_idx ON workers (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_records (expires_at);

INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
`;
