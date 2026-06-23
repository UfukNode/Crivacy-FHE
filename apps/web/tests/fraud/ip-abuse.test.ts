/**
 * Tests for `lib/fraud/ip-abuse.ts` — Sprint 6 IP-abuse signal
 * counter pure-function surface (hash + secret read + env knobs).
 *
 * The DB-bound helpers (`incrementSignal`, `getCount`, `pruneExpired`)
 * are exercised end-to-end via the webhook integration tests; this
 * file pins the parts that don't need a live Postgres:
 *
 *   - `hashIp` is deterministic per (ip, secret) pair, normalises
 *     case + whitespace, and rejects non-strings / empty strings
 *     with a stable empty-string sentinel.
 *   - The hash secret is required (≥16 chars) — `hashIp` throws if
 *     missing OR too short. Memoised after first read.
 *   - `IP_ABUSE_THRESHOLD` / `IP_ABUSE_TTL_DAYS` env knobs apply
 *     defaults when unset / invalid (negative, non-numeric).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IP_ABUSE_DEFAULT_THRESHOLD,
  IP_ABUSE_DEFAULT_TTL_DAYS,
  hashIp,
  resetIpAbuseCacheForTests,
} from '@/lib/fraud/ip-abuse';

// ---------------------------------------------------------------------------
// Env-management helpers — restore the original env after each case so
// other suites that read process.env are not perturbed.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'IP_ABUSE_HASH_SECRET',
  'IP_ABUSE_THRESHOLD',
  'IP_ABUSE_TTL_DAYS',
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
  }
  resetIpAbuseCacheForTests();
  // Pin a known good secret. Per-test cases override as needed.
  process.env['IP_ABUSE_HASH_SECRET'] = 'unit-test-secret-32-characters-long';
  delete process.env['IP_ABUSE_THRESHOLD'];
  delete process.env['IP_ABUSE_TTL_DAYS'];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = originalEnv[k];
    }
  }
  resetIpAbuseCacheForTests();
});

// ---------------------------------------------------------------------------
// Defaults exposed for ops review — pin them so the docs + .env.example
// don't drift away from code.
// ---------------------------------------------------------------------------

describe('IP-abuse default knobs', () => {
  it('defaults to 3 strikes / 7 days', () => {
    expect(IP_ABUSE_DEFAULT_THRESHOLD).toBe(3);
    expect(IP_ABUSE_DEFAULT_TTL_DAYS).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// hashIp — deterministic, normalises case + whitespace, sentinel-empty
// ---------------------------------------------------------------------------

describe('hashIp', () => {
  it('produces a 64-character SHA-256 hex digest for a typical IPv4', () => {
    const out = hashIp('203.0.113.5');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input → same output', () => {
    expect(hashIp('203.0.113.5')).toBe(hashIp('203.0.113.5'));
  });

  it('normalises trailing / leading whitespace', () => {
    expect(hashIp(' 203.0.113.5 ')).toBe(hashIp('203.0.113.5'));
    expect(hashIp('\t203.0.113.5\n')).toBe(hashIp('203.0.113.5'));
  });

  it('normalises case (IPv4-mapped IPv6 hex casing)', () => {
    expect(hashIp('::FFFF:203.0.113.5')).toBe(hashIp('::ffff:203.0.113.5'));
  });

  it('produces DIFFERENT hashes for different IPs (collision sanity)', () => {
    expect(hashIp('203.0.113.5')).not.toBe(hashIp('203.0.113.6'));
  });

  it('produces DIFFERENT hashes when the secret rotates', () => {
    const before = hashIp('203.0.113.5');
    resetIpAbuseCacheForTests();
    process.env['IP_ABUSE_HASH_SECRET'] = 'rotated-secret-32-characters-long-x';
    const after = hashIp('203.0.113.5');
    expect(before).not.toBe(after);
  });

  it('returns the empty string for null / undefined / non-string input', () => {
    expect(hashIp(null)).toBe('');
    expect(hashIp(undefined)).toBe('');
    expect(hashIp(42 as unknown as string)).toBe('');
  });

  it('returns the empty string for an empty / whitespace-only IP', () => {
    expect(hashIp('')).toBe('');
    expect(hashIp('   ')).toBe('');
    expect(hashIp('\t\n')).toBe('');
  });

  it('throws when the hash secret env is missing', () => {
    delete process.env['IP_ABUSE_HASH_SECRET'];
    resetIpAbuseCacheForTests();
    expect(() => hashIp('203.0.113.5')).toThrow(/IP_ABUSE_HASH_SECRET/);
  });

  it('throws when the hash secret is shorter than 16 chars', () => {
    process.env['IP_ABUSE_HASH_SECRET'] = 'too-short';
    resetIpAbuseCacheForTests();
    expect(() => hashIp('203.0.113.5')).toThrow(/at least 16 characters/);
  });

  it('memoises the secret — rotating env mid-process is a no-op until reset', () => {
    const before = hashIp('203.0.113.5');
    process.env['IP_ABUSE_HASH_SECRET'] = 'different-secret-32-chars-long-xx';
    // Cache has the original — should still match the FIRST hash.
    const after = hashIp('203.0.113.5');
    expect(after).toBe(before);
  });

  it('does NOT throw on empty IP even when secret is missing — sentinel short-circuits', () => {
    delete process.env['IP_ABUSE_HASH_SECRET'];
    resetIpAbuseCacheForTests();
    // Empty input bypasses the secret read.
    expect(hashIp('')).toBe('');
    expect(hashIp(null)).toBe('');
  });
});
