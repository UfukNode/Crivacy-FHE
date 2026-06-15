/**
 * Tests for the request-context builder.
 *
 * `buildRequestContext` is the sanitizer used by the middleware
 * layer before a context is handed to the writer. It enforces the
 * following invariants:
 *
 *   * `ip` accepts IPv4 and IPv6 (full and compressed), rejects
 *     obvious garbage, strips zone identifiers.
 *   * `userAgent` is trimmed and truncated to `MAX_USER_AGENT_LENGTH`.
 *   * `requestId` is a uuid v4 or null.
 *   * Empty / whitespace-only strings collapse to `null`.
 *
 * The `EMPTY_CONTEXT` singleton is checked to be frozen and all-null.
 */

import { describe, expect, it } from 'vitest';

import { AuditError, EMPTY_CONTEXT, MAX_USER_AGENT_LENGTH, buildRequestContext } from '@/lib/audit';

import { FIXTURE_REQUEST_ID } from './fixtures';

describe('EMPTY_CONTEXT', () => {
  it('has all-null fields', () => {
    expect(EMPTY_CONTEXT).toEqual({
      ip: null,
      userAgent: null,
      requestId: null,
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(EMPTY_CONTEXT)).toBe(true);
  });
});

describe('buildRequestContext — ip', () => {
  it('accepts IPv4 dotted quad', () => {
    const ctx = buildRequestContext({ ip: '203.0.113.42' });
    expect(ctx.ip).toBe('203.0.113.42');
  });

  it('accepts the IPv4 edge values 0.0.0.0 and 255.255.255.255', () => {
    expect(buildRequestContext({ ip: '0.0.0.0' }).ip).toBe('0.0.0.0');
    expect(buildRequestContext({ ip: '255.255.255.255' }).ip).toBe('255.255.255.255');
  });

  it('rejects IPv4 octets above 255', () => {
    expect(() => buildRequestContext({ ip: '256.0.0.0' })).toThrow(/IPv4 or IPv6/);
  });

  it('rejects IPv4 with only three octets', () => {
    expect(() => buildRequestContext({ ip: '10.0.0' })).toThrow(AuditError);
  });

  it('accepts full IPv6', () => {
    const ctx = buildRequestContext({ ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' });
    expect(ctx.ip).toBe('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
  });

  it('accepts compressed IPv6', () => {
    const ctx = buildRequestContext({ ip: '2001:db8::1' });
    expect(ctx.ip).toBe('2001:db8::1');
  });

  it('accepts IPv6 loopback ::1', () => {
    expect(buildRequestContext({ ip: '::1' }).ip).toBe('::1');
  });

  it('accepts unspecified ::', () => {
    expect(buildRequestContext({ ip: '::' }).ip).toBe('::');
  });

  it('strips zone identifier from link-local IPv6', () => {
    const ctx = buildRequestContext({ ip: 'fe80::1%eth0' });
    expect(ctx.ip).toBe('fe80::1');
  });

  it('rejects random garbage', () => {
    expect(() => buildRequestContext({ ip: 'hello-world' })).toThrow(AuditError);
  });

  it('collapses empty string to null', () => {
    expect(buildRequestContext({ ip: '' }).ip).toBeNull();
  });

  it('collapses whitespace-only string to null', () => {
    expect(buildRequestContext({ ip: '   ' }).ip).toBeNull();
  });

  it('passes null through as null', () => {
    expect(buildRequestContext({ ip: null }).ip).toBeNull();
  });

  it('treats undefined as null', () => {
    expect(buildRequestContext({}).ip).toBeNull();
  });
});

describe('buildRequestContext — userAgent', () => {
  it('accepts a normal UA string', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';
    expect(buildRequestContext({ userAgent: ua }).userAgent).toBe(ua);
  });

  it('trims leading/trailing whitespace', () => {
    const ctx = buildRequestContext({ userAgent: '  curl/8.1  ' });
    expect(ctx.userAgent).toBe('curl/8.1');
  });

  it('truncates at MAX_USER_AGENT_LENGTH', () => {
    const ua = 'x'.repeat(MAX_USER_AGENT_LENGTH + 500);
    const ctx = buildRequestContext({ userAgent: ua });
    expect(ctx.userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
  });

  it('keeps a UA of exactly MAX_USER_AGENT_LENGTH chars intact', () => {
    const ua = 'x'.repeat(MAX_USER_AGENT_LENGTH);
    const ctx = buildRequestContext({ userAgent: ua });
    expect(ctx.userAgent).toBe(ua);
  });

  it('collapses empty string to null', () => {
    expect(buildRequestContext({ userAgent: '' }).userAgent).toBeNull();
  });

  it('collapses whitespace-only string to null', () => {
    expect(buildRequestContext({ userAgent: '\t\n' }).userAgent).toBeNull();
  });

  it('passes null / undefined through as null', () => {
    expect(buildRequestContext({ userAgent: null }).userAgent).toBeNull();
    expect(buildRequestContext({}).userAgent).toBeNull();
  });
});

describe('buildRequestContext — requestId', () => {
  it('accepts a uuid v4', () => {
    expect(buildRequestContext({ requestId: FIXTURE_REQUEST_ID }).requestId).toBe(
      FIXTURE_REQUEST_ID,
    );
  });

  it('rejects non-uuid string', () => {
    expect(() => buildRequestContext({ requestId: 'xyz' })).toThrow(/uuid v4/);
  });

  it('rejects uuid v1 (wrong version nibble)', () => {
    expect(() =>
      buildRequestContext({
        requestId: '11111111-1111-1111-8111-111111111111',
      }),
    ).toThrow(AuditError);
  });

  it('collapses empty string to null', () => {
    expect(buildRequestContext({ requestId: '' }).requestId).toBeNull();
  });

  it('passes null / undefined through as null', () => {
    expect(buildRequestContext({ requestId: null }).requestId).toBeNull();
    expect(buildRequestContext({}).requestId).toBeNull();
  });
});

describe('buildRequestContext — result shape', () => {
  it('returns a frozen context object', () => {
    const ctx = buildRequestContext({
      ip: '10.0.0.1',
      userAgent: 'vitest/1.0',
      requestId: FIXTURE_REQUEST_ID,
    });
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('returns the full shape with all three fields set', () => {
    const ctx = buildRequestContext({
      ip: '10.0.0.1',
      userAgent: 'vitest/1.0',
      requestId: FIXTURE_REQUEST_ID,
    });
    expect(ctx).toEqual({
      ip: '10.0.0.1',
      userAgent: 'vitest/1.0',
      requestId: FIXTURE_REQUEST_ID,
    });
  });
});

describe('AuditError code for context failures', () => {
  it('throws invalid_context on bad ip', () => {
    try {
      buildRequestContext({ ip: 'bad' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditError);
      expect((err as AuditError).code).toBe('invalid_context');
    }
  });

  it('throws invalid_context on bad requestId', () => {
    try {
      buildRequestContext({ requestId: 'not-a-uuid' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditError);
      expect((err as AuditError).code).toBe('invalid_context');
    }
  });
});
