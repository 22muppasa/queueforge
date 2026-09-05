import { createHash, randomInt } from 'node:crypto';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprint(value: unknown): string {
  return sha256(stableStringify(value));
}

export function fullJitterDelay(attempt: number, baseMs: number, capMs: number, random: (max: number) => number = (max) => randomInt(max + 1)) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const rawMs = Math.min(capMs, baseMs * 2 ** exponent);
  const boundedRawMs = Math.max(0, Math.floor(rawMs));
  return { rawMs: boundedRawMs, delayMs: random(boundedRawMs) };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
