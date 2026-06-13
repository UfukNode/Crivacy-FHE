/**
 * Tests for the request context module.
 *
 * Covers every public export:
 *
 *   * `extractClientIp`        — header precedence, edge cases
 *   * `extractUserAgent`       — normal, null, empty, truncation
 *   * `buildResponseHelpers`   — json / noContent / errorJson shape
 *   * `buildRequestContext`    — field wiring, DI, freeze contract
 *   * `buildAuthenticatedContext` — extends base, nested freeze
 *   * `applyRateLimitHeaders`  — header set, null passthrough
 *
 * No real DB or HTTP server needed — everything is deterministic.
 */

import { describe, expect, it } from 'vitest';

import {
  applyRateLimitHeaders,
  buildAuthenticatedContext,
  buildRequestContext,
  buildResponseHelpers,
  extractClientIp,
  extractUserAgent,
} from '@/server/context';

import {
  FIXTURE_NOW,
  FIXTURE_REQUEST_ID,
  buildMockDb,
  buildRateLimitSnapshot,
  buildResolvedApiKey,
  buildResolvedFirm,
  buildTestRequest,
  fixtureClock,
  fixtureRequestIdFactory,
} from './fixtures';

/* ================================================================== */
/*  extractClientIp                                                    */
/* ================================================================== */

describe('extractClientIp', () => {
  it('returns the first IP from x-forwarded-for', () => {
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
    });
    expect(extractClientIp(req)).toBe('1.2.3.4');
  });

  it('returns a single x-forwarded-for value', () => {
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '192.168.1.1' },
    });
    expect(extractClientIp(req)).toBe('192.168.1.1');
  });

  it('trims whitespace in x-forwarded-for entries', () => {
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '  1.2.3.4  , 10.0.0.1' },
    });
    expect(extractClientIp(req)).toBe('1.2.3.4');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const req = buildTestRequest({
      headers: { 'x-real-ip': '5.6.7.8' },
    });
    expect(extractClientIp(req)).toBe('5.6.7.8');
  });

  it('prefers x-forwarded-for over x-real-ip', () => {
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
    });
    expect(extractClientIp(req)).toBe('1.2.3.4');
  });

  it('returns null when no IP headers are present', () => {
    const req = buildTestRequest();
    expect(extractClientIp(req)).toBeNull();
  });

  it('returns null when x-forwarded-for is empty', () => {
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '' },
    });
    expect(extractClientIp(req)).toBeNull();
  });

  it('returns null when x-forwarded-for entry is only whitespace', () => {
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': '   ' },
    });
    expect(extractClientIp(req)).toBeNull();
  });

  it('rejects an IP longer than 45 chars (IPv6 max)', () => {
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': 'a'.repeat(46) },
    });
    expect(extractClientIp(req)).toBeNull();
  });

  it('accepts a max-length IPv6 address (45 chars)', () => {
    // Valid max-length IPv6 is 45 chars e.g. with embedded IPv4
    const maxIp = '0000:0000:0000:0000:0000:ffff:255.255.255.255';
    expect(maxIp.length).toBeLessThanOrEqual(45);
    const req = buildTestRequest({
      headers: { 'x-forwarded-for': maxIp },
    });
    expect(extractClientIp(req)).toBe(maxIp);
  });

  it('rejects x-real-ip longer than 45 chars', () => {
    const req = buildTestRequest({
      headers: { 'x-real-ip': 'b'.repeat(46) },
    });
    expect(extractClientIp(req)).toBeNull();
  });
});

/* ================================================================== */
/*  extractUserAgent                                                   */
/* ================================================================== */

describe('extractUserAgent', () => {
  it('returns the user-agent header as-is', () => {
    const req = buildTestRequest({
      headers: { 'user-agent': 'CrivacySDK/1.0' },
    });
    expect(extractUserAgent(req)).toBe('CrivacySDK/1.0');
  });

  it('returns null when user-agent is absent', () => {
    const req = buildTestRequest();
    expect(extractUserAgent(req)).toBeNull();
  });

  it('returns null when user-agent is empty', () => {
    const req = buildTestRequest({
      headers: { 'user-agent': '' },
    });
    expect(extractUserAgent(req)).toBeNull();
  });

  it('truncates user-agent to 1024 chars', () => {
    const longUa = 'X'.repeat(2000);
    const req = buildTestRequest({
      headers: { 'user-agent': longUa },
    });
    const result = extractUserAgent(req);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(1024);
  });

  it('preserves a user-agent exactly 1024 chars', () => {
    const exactUa = 'Y'.repeat(1024);
    const req = buildTestRequest({
      headers: { 'user-agent': exactUa },
    });
    expect(extractUserAgent(req)).toBe(exactUa);
  });
});

/* ================================================================== */
/*  buildResponseHelpers                                               */
/* ================================================================== */

describe('buildResponseHelpers', () => {
  it('json() returns a 200 response with the request id header', async () => {
    const helpers = buildResponseHelpers(FIXTURE_REQUEST_ID);
    const res = helpers.json({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe(FIXTURE_REQUEST_ID);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('json() accepts a custom status', async () => {
    const helpers = buildResponseHelpers(FIXTURE_REQUEST_ID);
    const res = helpers.json({ created: true }, 201);
    expect(res.status).toBe(201);
  });

  it('noContent() returns a 204 with no body', () => {
    const helpers = buildResponseHelpers(FIXTURE_REQUEST_ID);
    const res = helpers.noContent();
    expect(res.status).toBe(204);
    expect(res.headers.get('x-request-id')).toBe(FIXTURE_REQUEST_ID);
    expect(res.body).toBeNull();
  });

  it('errorJson() returns the ApiErrorBody shape', async () => {
    const helpers = buildResponseHelpers(FIXTURE_REQUEST_ID);
    const res = helpers.errorJson('validation_failed', 'Bad input', 400, {
      issues: [{ path: 'email', message: 'required' }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        requestId: string;
        details: { issues: { path: string; message: string }[] };
      };
    };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toBe('Bad input');
    expect(body.error.requestId).toBe(FIXTURE_REQUEST_ID);
    expect(body.error.details.issues).toHaveLength(1);
  });

  it('errorJson() omits details when not provided', async () => {
    const helpers = buildResponseHelpers(FIXTURE_REQUEST_ID);
    const res = helpers.errorJson('not_found', 'Not found', 404);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['details']).toBeUndefined();
  });
});

/* ================================================================== */
/*  buildRequestContext                                                */
/* ================================================================== */

describe('buildRequestContext', () => {
  it('populates all fields from the request', () => {
    const db = buildMockDb();
    const req = buildTestRequest({
      method: 'POST',
      url: 'https://api.crivacy.test/api/v1/sessions?limit=10',
      headers: {
        'x-forwarded-for': '10.0.0.1',
        'user-agent': 'TestAgent/1.0',
      },
    });
    const ctx = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);

    expect(ctx.requestId).toBe(FIXTURE_REQUEST_ID);
    expect(ctx.db).toBe(db);
    expect(ctx.now).toBe(FIXTURE_NOW);
    expect(typeof ctx.startedAt).toBe('number');
    expect(ctx.ip).toBe('10.0.0.1');
    expect(ctx.userAgent).toBe('TestAgent/1.0');
    expect(ctx.method).toBe('POST');
    expect(ctx.path).toBe('/api/v1/sessions');
    expect(ctx.request).toBe(req);
  });

  it('uses injected clock and request ID factory', () => {
    const customDate = new Date('2020-01-01T00:00:00Z');
    const customId = 'custom-id-value';
    const db = buildMockDb();
    const req = buildTestRequest();
    const ctx = buildRequestContext(
      req,
      db,
      () => customDate,
      () => customId,
    );
    expect(ctx.now).toBe(customDate);
    expect(ctx.requestId).toBe(customId);
  });

  it('returns a frozen object', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const ctx = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('attaches working response helpers', async () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const ctx = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);

    const jsonRes = ctx.json({ value: 1 }, 201);
    expect(jsonRes.status).toBe(201);
    expect(jsonRes.headers.get('x-request-id')).toBe(FIXTURE_REQUEST_ID);

    const ncRes = ctx.noContent();
    expect(ncRes.status).toBe(204);

    const errRes = ctx.errorJson('test_error', 'fail', 500);
    expect(errRes.status).toBe(500);
    const body = (await errRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe('test_error');
  });

  it('extracts path without query string', () => {
    const db = buildMockDb();
    const req = buildTestRequest({
      url: 'https://api.crivacy.test/api/v1/sessions?cursor=abc&limit=25',
    });
    const ctx = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    expect(ctx.path).toBe('/api/v1/sessions');
  });

  it('sets ip to null when no IP headers are present', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const ctx = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    expect(ctx.ip).toBeNull();
  });

  it('sets userAgent to null when the header is absent', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const ctx = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    expect(ctx.userAgent).toBeNull();
  });
});

/* ================================================================== */
/*  buildAuthenticatedContext                                          */
/* ================================================================== */

describe('buildAuthenticatedContext', () => {
  it('extends the base context with apiKey, firm, and rateLimit', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const apiKey = buildResolvedApiKey();
    const firm = buildResolvedFirm();
    const rl = buildRateLimitSnapshot();

    const ctx = buildAuthenticatedContext(base, apiKey, firm, rl);

    // Base fields flow through
    expect(ctx.requestId).toBe(FIXTURE_REQUEST_ID);
    expect(ctx.db).toBe(db);
    expect(ctx.now).toBe(FIXTURE_NOW);

    // Auth fields
    expect(ctx.apiKey.id).toBe(apiKey.id);
    expect(ctx.apiKey.firmId).toBe(apiKey.firmId);
    expect(ctx.firm.id).toBe(firm.id);
    expect(ctx.firm.slug).toBe('test-firm');
    expect(ctx.firm.tier).toBe('starter');

    // Rate limit
    expect(ctx.rateLimit).not.toBeNull();
    expect(ctx.rateLimit?.limit).toBe(100);
    expect(ctx.rateLimit?.remaining).toBe(42);
  });

  it('returns a frozen object', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const ctx = buildAuthenticatedContext(
      base,
      buildResolvedApiKey(),
      buildResolvedFirm(),
      buildRateLimitSnapshot(),
    );
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('freezes the nested apiKey', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const ctx = buildAuthenticatedContext(base, buildResolvedApiKey(), buildResolvedFirm(), null);
    expect(Object.isFrozen(ctx.apiKey)).toBe(true);
  });

  it('freezes the nested firm', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const ctx = buildAuthenticatedContext(base, buildResolvedApiKey(), buildResolvedFirm(), null);
    expect(Object.isFrozen(ctx.firm)).toBe(true);
  });

  it('freezes the nested rateLimit when present', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const ctx = buildAuthenticatedContext(
      base,
      buildResolvedApiKey(),
      buildResolvedFirm(),
      buildRateLimitSnapshot(),
    );
    expect(ctx.rateLimit).not.toBeNull();
    expect(Object.isFrozen(ctx.rateLimit)).toBe(true);
  });

  it('accepts null rateLimit', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const ctx = buildAuthenticatedContext(base, buildResolvedApiKey(), buildResolvedFirm(), null);
    expect(ctx.rateLimit).toBeNull();
  });

  it('preserves response helpers from the base context', async () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const ctx = buildAuthenticatedContext(base, buildResolvedApiKey(), buildResolvedFirm(), null);
    const res = ctx.json({ test: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe(FIXTURE_REQUEST_ID);
  });
});

/* ================================================================== */
/*  applyRateLimitHeaders                                              */
/* ================================================================== */

describe('applyRateLimitHeaders', () => {
  it('sets all three rate-limit headers', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const res = base.json({ ok: true });
    const snapshot = buildRateLimitSnapshot({
      limit: 200,
      remaining: 199,
      resetSeconds: 30,
    });

    const patched = applyRateLimitHeaders(res, snapshot);
    expect(patched.headers.get('x-ratelimit-limit')).toBe('200');
    expect(patched.headers.get('x-ratelimit-remaining')).toBe('199');
    expect(patched.headers.get('x-ratelimit-reset')).toBe('30');
  });

  it('returns the same response reference (mutates in place)', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const res = base.json({ ok: true });
    const snapshot = buildRateLimitSnapshot();
    const patched = applyRateLimitHeaders(res, snapshot);
    expect(patched).toBe(res);
  });

  it('skips headers when snapshot is null', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const res = base.json({ ok: true });

    const patched = applyRateLimitHeaders(res, null);
    expect(patched.headers.get('x-ratelimit-limit')).toBeNull();
    expect(patched.headers.get('x-ratelimit-remaining')).toBeNull();
    expect(patched.headers.get('x-ratelimit-reset')).toBeNull();
  });

  it('preserves existing headers on the response', () => {
    const db = buildMockDb();
    const req = buildTestRequest();
    const base = buildRequestContext(req, db, fixtureClock, fixtureRequestIdFactory);
    const res = base.json({ ok: true });

    const patched = applyRateLimitHeaders(res, buildRateLimitSnapshot());
    // The x-request-id from buildResponseHelpers should still be there
    expect(patched.headers.get('x-request-id')).toBe(FIXTURE_REQUEST_ID);
    // And the rate-limit headers too
    expect(patched.headers.get('x-ratelimit-limit')).toBe('100');
  });
});
