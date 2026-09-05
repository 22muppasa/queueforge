export const JOB_STATUSES = ['queued', 'running', 'retry_wait', 'succeeded', 'dead_lettered', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface SubmitJob {
  clientId: string;
  idempotencyKey?: string;
  queue: string;
  type: string;
  payload: JsonObject;
  priority: number;
  availableAt: Date;
  availableAtFingerprint?: string;
  maxAttempts: number;
  timeoutMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  redriveOfJobId?: string;
}

export interface Job {
  id: string;
  client_id: string;
  queue: string;
  type: string;
  payload: JsonObject;
  status: JobStatus;
  priority: number;
  available_at: string;
  attempts_started: number;
  max_attempts: number;
  timeout_ms: number;
  backoff_base_ms: number;
  backoff_cap_ms: number;
  lease_owner: string | null;
  lease_owner_name?: string | null;
  lease_generation: string;
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  cancel_requested_at: string | null;
  first_started_at: string | null;
  finished_at: string | null;
  result: JsonValue | null;
  last_error: JsonObject | null;
  redrive_of_job_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimedJob extends Job {
  lease_token: string;
}

export class RetryableJobError extends Error {
  override name = 'RetryableJobError';
}

export class PermanentJobError extends Error {
  override name = 'PermanentJobError';
}

export class LostLeaseError extends Error {
  override name = 'LostLeaseError';
}
