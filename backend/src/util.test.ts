import { describe, expect, it } from 'vitest';
import { fingerprint, fullJitterDelay, stableStringify } from './util.js';

describe('stableStringify', () => {
  it('canonicalizes object key ordering recursively', () => {
    expect(stableStringify({ z: 1, a: { y: 2, x: 3 } })).toBe(stableStringify({ a: { x: 3, y: 2 }, z: 1 }));
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });
});

describe('fullJitterDelay', () => {
  it('uses the initial attempt as exponent zero', () => {
    expect(fullJitterDelay(1, 100, 10_000, (max) => max)).toEqual({ rawMs: 100, delayMs: 100 });
    expect(fullJitterDelay(2, 100, 10_000, (max) => max)).toEqual({ rawMs: 200, delayMs: 200 });
  });

  it('caps safely and accepts deterministic randomness', () => {
    expect(fullJitterDelay(1000, 1_000, 5_000, () => 123)).toEqual({ rawMs: 5_000, delayMs: 123 });
  });
});
