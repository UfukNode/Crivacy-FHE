/**
 * Trust-aware client IP extraction tests.
 *
 * `extractClientIp` has two modes:
 *
 *   - **Legacy leftmost** (no `AUTH_TRUSTED_PROXY_HOPS`): kept for
 *     backward compatibility so dev / test runs keep working
 *     without new env wiring. Insecure — the leftmost XFF entry is
 *     client-controlled. The main context test file covers this
 *     branch; this file additionally asserts that a production
 *     deployment without the env set fails loud instead of silently
 *     accepting the spoofable fallback.
 *
 *   - **Strict right-parse** (`AUTH_TRUSTED_PROXY_HOPS=N`): peels
 *     the last N entries off XFF as our own proxies and takes the
 *     entry just beyond them as the real client. `CF-Connecting-IP`
 *     always wins when present regardless of the mode.
 *
 * These cases pin the security contract: once the env is set, a
 * client cannot forge its own IP by adding a leading XFF value.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractClientIp,
  resetTrustedProxyConfigForTests,
} from '@/server/context';

import { buildTestRequest } from './fixtures';

// ---------------------------------------------------------------------------

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetTrustedProxyConfigForTests();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  resetTrustedProxyConfigForTests();
});

// ---------------------------------------------------------------------------

describe('extractClientIp — CF-Connecting-IP precedence', () => {
  it('returns the Cloudflare header even when XFF is present', () => {
    const req = buildTestRequest({
      headers: {
        'cf-connecting-ip': '203.0.113.7',
        // XFF is still set by Cloudflare itself but reflects the
        // proxy chain below the edge. The helper must ignore it
        // when CF-Connecting-IP is available.
        'x-forwarded-for': '198.51.100.10, 10.0.0.5',
      },
    });
    expect(extractClientIp(req)).toBe('203.0.113.7');
  });

  it('uses CF-Connecting-IP even with AUTH_TRUSTED_PROXY_HOPS set', () => {
    process.env['AUTH_TRUSTED_PROXY_HOPS'] = '1';
    const req = buildTestRequest({
      headers: {
        'cf-connecting-ip': '203.0.113.8',
        'x-forwarded-for': 'attacker-spoof, 198.51.100.10',
      },
    });
    expect(extractClientIp(req)).toBe('203.0.113.8');
  });

  it('rejects an over-length CF-Connecting-IP (sanity guard)', () => {
    const req = buildTestRequest({
      headers: {
        'cf-connecting-ip': 'a'.repeat(46),
        'x-forwarded-for': '198.51.100.10',
      },
    });
    // Falls back to XFF (legacy, no env set).
    expect(extractClientIp(req)).toBe('198.51.100.10');
  });
});

// ---------------------------------------------------------------------------

describe('extractClientIp — strict right-parse mode', () => {
  it('with 1 trusted hop, peels the rightmost entry and returns the one before it', () => {
    process.env['AUTH_TRUSTED_PROXY_HOPS'] = '1';
    // Chain: client (1.1.1.1) → trusted proxy (2.2.2.2) → origin.
    // Our proxy appended its own address to XFF — we trust it
    // (1 hop) and take the entry just beyond it.
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    });
    expect(extractClientIp(req)).toBe('1.1.1.1');
  });

  it('with 2 trusted hops, peels both proxies and returns the next entry', () => {
    process.env['AUTH_TRUSTED_PROXY_HOPS'] = '2';
    // Chain: client (1.1.1.1) → edge (2.2.2.2) → LB (3.3.3.3)
    // → origin. Trust both our hops, take what's just beyond.
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' },
    });
    expect(extractClientIp(req)).toBe('1.1.1.1');
  });

  it('ignores a leading attacker-spoofed entry when hops are configured', () => {
    process.env['AUTH_TRUSTED_PROXY_HOPS'] = '1';
    // Attacker added a leading `9.9.9.9` via a Host-level header
    // before it reached our proxy. Strict mode discards it.
    const req = buildTestRequest({
      headers: {
        'x-forwarded-for': '9.9.9.9, 1.1.1.1, 2.2.2.2',
      },
    });
    // `entries.length - 1 - 1 = 3 - 2 = 1` → `1.1.1.1` (real client).
    expect(extractClientIp(req)).toBe('1.1.1.1');
  });

  it('with 0 trusted hops, treats the rightmost entry as the client', () => {
    process.env['AUTH_TRUSTED_PROXY_HOPS'] = '0';
    // No proxy we own — whatever talked to us last is the "client"
    // under this config. Often used when the runtime socket IS the
    // edge (single-process deployments).
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    });
    expect(extractClientIp(req)).toBe('2.2.2.2');
  });

  it('falls back to X-Real-IP when strict mode is set but XFF is missing', () => {
    process.env['AUTH_TRUSTED_PROXY_HOPS'] = '1';
    const req = buildTestRequest({
      headers: { 'x-real-ip': '4.4.4.4' },
    });
    expect(extractClientIp(req)).toBe('4.4.4.4');
  });

  it('returns null in strict mode when XFF has fewer entries than trusted hops', () => {
    process.env['AUTH_TRUSTED_PROXY_HOPS'] = '2';
    // Only one entry — not enough to trust 2 hops, so refuse
    // rather than pick an attacker-controlled value.
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    expect(extractClientIp(req)).toBeNull();
  });

  it('rejects a non-integer AUTH_TRUSTED_PROXY_HOPS and falls back to legacy', () => {
    process.env['AUTH_TRUSTED_PROXY_HOPS'] = 'abc';
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    });
    // Legacy leftmost resurfaces — the drift would be flagged by
    // the prod warning above, but in tests we only care that the
    // result is predictable.
    expect(extractClientIp(req)).toBe('1.1.1.1');
  });

  it('rejects a negative AUTH_TRUSTED_PROXY_HOPS and falls back to legacy', () => {
    process.env['AUTH_TRUSTED_PROXY_HOPS'] = '-1';
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    });
    expect(extractClientIp(req)).toBe('1.1.1.1');
  });
});

// ---------------------------------------------------------------------------

describe('extractClientIp — production misconfig fail-loud', () => {
  it('throws when AUTH_TRUSTED_PROXY_HOPS is absent in production', () => {
    process.env = { ...process.env, NODE_ENV: 'production' };
    delete process.env['AUTH_TRUSTED_PROXY_HOPS'];

    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    expect(() => extractClientIp(req)).toThrow(/AUTH_TRUSTED_PROXY_HOPS/);
  });

  it('throws when AUTH_TRUSTED_PROXY_HOPS is empty in production', () => {
    process.env = { ...process.env, NODE_ENV: 'production', AUTH_TRUSTED_PROXY_HOPS: '   ' };

    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    expect(() => extractClientIp(req)).toThrow(/AUTH_TRUSTED_PROXY_HOPS/);
  });

  it('does NOT throw in non-production environments with the env missing', () => {
    process.env = { ...process.env, NODE_ENV: 'development' };
    delete process.env['AUTH_TRUSTED_PROXY_HOPS'];

    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    expect(() => extractClientIp(req)).not.toThrow();
    expect(extractClientIp(req)).toBe('1.1.1.1');
  });

  it('does NOT throw in production once AUTH_TRUSTED_PROXY_HOPS is set', () => {
    process.env = { ...process.env, NODE_ENV: 'production', AUTH_TRUSTED_PROXY_HOPS: '1' };

    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.5' },
    });
    expect(() => extractClientIp(req)).not.toThrow();
    expect(extractClientIp(req)).toBe('1.1.1.1');
  });
});
