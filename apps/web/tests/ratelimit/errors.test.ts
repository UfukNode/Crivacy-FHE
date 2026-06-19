/**
 * `RateLimitError` is deliberately narrow — a single class with a
 * `code` discriminator, optional `cause`, and structured `details`.
 * These tests lock the shape so a future refactor that accidentally
 * widens the contract (adding a new mandatory field, changing the
 * `name` string, forgetting to forward `cause`) fails loudly rather
 * than silently changing how route code catches it.
 */

import { describe, expect, it } from 'vitest';

import { RateLimitError } from '@/lib/ratelimit';

describe('RateLimitError', () => {
  it('carries the code argument on the typed property', () => {
    const err = new RateLimitError('invalid_tier_config', 'oops');
    expect(err.code).toBe('invalid_tier_config');
    expect(err.message).toBe('oops');
    expect(err.name).toBe('RateLimitError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('forwards the underlying cause through the Error cause property', () => {
    const underlying = new Error('driver failure');
    const err = new RateLimitError('bucket_row_missing', 'row gone', { cause: underlying });
    // Error#cause is part of the ES spec; Node exposes it as a
    // non-enumerable property but it must round-trip.
    expect(err.cause).toBe(underlying);
  });

  it('omits the cause property when none is supplied', () => {
    const err = new RateLimitError('unknown_tier', 'no such tier');
    expect(err.cause).toBeUndefined();
  });

  it('carries structured details verbatim', () => {
    const err = new RateLimitError('bucket_row_malformed', 'bad tokens', {
      details: { field: 'tokens', raw: 'NaN' },
    });
    expect(err.details).toEqual({ field: 'tokens', raw: 'NaN' });
  });

  it('freezes the set of recognized codes (spot checks)', () => {
    // TypeScript enforces the union at compile time; runtime check
    // only verifies that valid names are accepted without runtime
    // surprise (e.g. a dev renaming one of them to a trimmed string).
    const codes = [
      'unknown_tier',
      'invalid_tier_config',
      'bucket_row_missing',
      'bucket_row_malformed',
      'quota_row_missing',
      'quota_row_malformed',
      'period_calculation_failed',
      'invalid_request_cost',
      'invalid_now_value',
    ] as const;
    for (const code of codes) {
      const err = new RateLimitError(code, `msg for ${code}`);
      expect(err.code).toBe(code);
    }
  });
});
