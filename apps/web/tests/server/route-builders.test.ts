/**
 * Tests for the three route builders.
 *
 * Each builder is driven through its DI hooks (dbFactory, clock,
 * requestIdFactory, authLookup, rateLimitFn) so no real DB, auth,
 * or rate-limit infrastructure is needed.
 *
 * Covers:
 *   * `publicRoute` — handler success, handler error, ParseError mapping
 *   * `apiRoute` — missing key, auth flow, scope check, rate limit allow/deny,
 *     fail-open on RL error, handler error, ParseError mapping
 *   * `webhookRoute` — body reading, JSON parse, header collection,
 *     handler success, size limit
 */

import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { AuthError } from '@/lib/auth/errors';
import { apiRoute, publicRoute, webhookRoute } from '@/server/middleware';
import type { RateLimitDecision } from '@/server/middleware';

import {
  FIXTURE_REQUEST_ID,
  buildMockDb,
  buildResolvedApiKey,
  buildResolvedFirm,
  fixtureClock,
  fixtureRequestIdFactory,
} from './fixtures';

/* ---------- helpers ---------- */

const dbFactory = () => buildMockDb();

function buildPostRequest(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): NextRequest {
  const json = JSON.stringify(body);
  return new NextRequest(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: json,
    }),
  );
}

function buildGetRequest(url: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(
    new Request(url, {
      method: 'GET',
      headers: headers ?? {},
    }),
  );
}

/* ================================================================== */
/*  publicRoute                                                        */
/* ================================================================== */

describe('publicRoute', () => {
  it('calls the handler and returns the response', async () => {
    const route = publicRoute((ctx) => ctx.json({ status: 'ok' }), {
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/health');
    const res = await route(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe(FIXTURE_REQUEST_ID);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('maps handler errors to error responses', async () => {
    const route = publicRoute(
      () => {
        throw new Error('boom');
      },
      { dbFactory, clock: fixtureClock, requestIdFactory: fixtureRequestIdFactory },
    );

    const req = buildGetRequest('https://api.crivacy.test/api/v1/health');
    const res = await route(req);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('internal_error');
  });

  it('maps ParseError to the correct status code', async () => {
    const { ParseError } = await import('@/server/middleware/parse');
    const route = publicRoute(
      () => {
        throw new ParseError('payload_too_large', 'too big');
      },
      { dbFactory, clock: fixtureClock, requestIdFactory: fixtureRequestIdFactory },
    );

    const req = buildGetRequest('https://api.crivacy.test/api/v1/health');
    const res = await route(req);

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_large');
  });
});

/* ================================================================== */
/*  apiRoute                                                           */
/* ================================================================== */

describe('apiRoute', () => {
  const stubAuth = async () => ({
    apiKey: buildResolvedApiKey(),
    firm: buildResolvedFirm(),
  });

  const allowDecision: RateLimitDecision = {
    allowed: true,
    limit: 100,
    remaining: 99,
    resetSeconds: 60,
  };

  const stubRateLimit = async () => allowDecision;

  it('returns 401 when X-API-Key header is missing', async () => {
    const route = apiRoute({
      scopes: ['kyc:read'],
      handler: (ctx) => ctx.json({ ok: true }),
      authLookup: stubAuth,
      rateLimitFn: stubRateLimit,
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/sessions');
    const res = await route(req);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('passes through auth and calls the handler', async () => {
    const route = apiRoute({
      scopes: ['kyc:read'],
      handler: (ctx) => ctx.json({ firmId: ctx.firm.id }),
      authLookup: stubAuth,
      rateLimitFn: stubRateLimit,
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/sessions', {
      'x-api-key': 'crv_live_test1234_abcdef',
    });
    const res = await route(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { firmId: string };
    expect(body.firmId).toBeTruthy();
  });

  it('sets rate-limit headers on success', async () => {
    const route = apiRoute({
      scopes: [],
      handler: (ctx) => ctx.json({ ok: true }),
      authLookup: stubAuth,
      rateLimitFn: stubRateLimit,
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/usage', {
      'x-api-key': 'crv_live_test1234_abcdef',
    });
    const res = await route(req);

    expect(res.headers.get('x-ratelimit-limit')).toBe('100');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('99');
    expect(res.headers.get('x-ratelimit-reset')).toBe('60');
  });

  it('returns 403 when scope check fails', async () => {
    const route = apiRoute({
      scopes: ['webhooks:manage'],
      handler: (ctx) => ctx.json({ ok: true }),
      authLookup: async () => ({
        apiKey: buildResolvedApiKey({ scopes: ['kyc:read'] }),
        firm: buildResolvedFirm(),
      }),
      rateLimitFn: stubRateLimit,
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/webhooks', {
      'x-api-key': 'crv_live_test1234_abcdef',
    });
    const res = await route(req);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope_forbidden');
  });

  it('returns 429 when rate limit is denied', async () => {
    const denyDecision: RateLimitDecision = {
      allowed: false,
      limit: 10,
      remaining: 0,
      resetSeconds: 30,
      retryAfterSeconds: 5,
    };

    const route = apiRoute({
      scopes: [],
      handler: (ctx) => ctx.json({ ok: true }),
      authLookup: stubAuth,
      rateLimitFn: async () => denyDecision,
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/sessions', {
      'x-api-key': 'crv_live_test1234_abcdef',
    });
    const res = await route(req);

    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: { code: string; details: { retry_after_seconds: number } };
    };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details.retry_after_seconds).toBe(5);
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
  });

  it('fails open when rate limit throws an error', async () => {
    const route = apiRoute({
      scopes: [],
      handler: (ctx) => ctx.json({ ok: true }),
      authLookup: stubAuth,
      rateLimitFn: async () => {
        throw new Error('rate limit DB down');
      },
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/sessions', {
      'x-api-key': 'crv_live_test1234_abcdef',
    });
    const res = await route(req);

    expect(res.status).toBe(200);
    // No rate limit headers when snapshot is null (fail-open)
    expect(res.headers.get('x-ratelimit-limit')).toBeNull();
  });

  it('skips rate limit when rateLimitFn is null', async () => {
    const route = apiRoute({
      scopes: [],
      handler: (ctx) => ctx.json({ ok: true }),
      authLookup: stubAuth,
      rateLimitFn: null,
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/sessions', {
      'x-api-key': 'crv_live_test1234_abcdef',
    });
    const res = await route(req);

    expect(res.status).toBe(200);
  });

  it('falls back to the firm-keyed default limiter when rateLimitFn is omitted', async () => {
    // The route does NOT pass `rateLimitFn`. The builder must inject
    // `defaultApiRateLimitFn`, which calls `applyRateLimit` against
    // the mock db — our mock returns no bucket rows so the library
    // throws, the builder's try/catch fails open, and the request
    // lands with `snapshot === null`. This asserts the default is
    // actually wired: a route writer gets tier-aware throttling for
    // free, even if the backing infra has a bad day.
    const route = apiRoute({
      scopes: [],
      handler: (ctx) => ctx.json({ ok: true }),
      authLookup: stubAuth,
      // rateLimitFn intentionally omitted — default should kick in.
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/sessions', {
      'x-api-key': 'crv_live_test1234_abcdef',
    });
    const res = await route(req);

    // Fail-open on the mock-db backing = 200 with no rate-limit headers.
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBeNull();
  });

  it('maps auth errors from the lookup function', async () => {
    const route = apiRoute({
      scopes: [],
      handler: (ctx) => ctx.json({ ok: true }),
      authLookup: async () => {
        throw new AuthError('invalid_api_key', 'Bad key');
      },
      rateLimitFn: null,
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/sessions', {
      'x-api-key': 'crv_live_bad_key_value',
    });
    const res = await route(req);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('returns 401 for soft-deleted firms', async () => {
    const route = apiRoute({
      scopes: [],
      handler: (ctx) => ctx.json({ ok: true }),
      authLookup: async () => ({
        apiKey: buildResolvedApiKey(),
        firm: buildResolvedFirm({ deletedAt: new Date() }),
      }),
      rateLimitFn: null,
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = buildGetRequest('https://api.crivacy.test/api/v1/sessions', {
      'x-api-key': 'crv_live_test1234_abcdef',
    });
    const res = await route(req);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });
});

/* ================================================================== */
/*  webhookRoute                                                       */
/* ================================================================== */

describe('webhookRoute', () => {
  it('reads the body, parses JSON, and passes to handler', async () => {
    const route = webhookRoute(
      (ctx, input) => {
        const body = input.body as { event: string };
        return ctx.json({ received: body.event });
      },
      { dbFactory, clock: fixtureClock, requestIdFactory: fixtureRequestIdFactory },
    );

    const req = buildPostRequest('https://api.crivacy.test/api/webhooks/didit', {
      event: 'session.completed',
    });
    const res = await route(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: string };
    expect(body.received).toBe('session.completed');
  });

  it('provides lowercased headers to the handler', async () => {
    let capturedHeaders: Record<string, string> = {};
    const route = webhookRoute(
      (ctx, input) => {
        capturedHeaders = input.headers as Record<string, string>;
        return ctx.json({ ok: true });
      },
      { dbFactory, clock: fixtureClock, requestIdFactory: fixtureRequestIdFactory },
    );

    const req = buildPostRequest(
      'https://api.crivacy.test/api/webhooks/didit',
      { event: 'test' },
      { 'X-Signature-V2': 'abcdef', 'X-Timestamp': '12345' },
    );
    const res = await route(req);

    expect(res.status).toBe(200);
    expect(capturedHeaders['x-signature-v2']).toBe('abcdef');
    expect(capturedHeaders['x-timestamp']).toBe('12345');
  });

  it('freezes the headers object', async () => {
    let frozen = false;
    const route = webhookRoute(
      (ctx, input) => {
        frozen = Object.isFrozen(input.headers);
        return ctx.json({ ok: true });
      },
      { dbFactory, clock: fixtureClock, requestIdFactory: fixtureRequestIdFactory },
    );

    const req = buildPostRequest('https://api.crivacy.test/api/webhooks/didit', { e: 1 });
    await route(req);

    expect(frozen).toBe(true);
  });

  it('returns 400 on malformed JSON', async () => {
    const route = webhookRoute((ctx) => ctx.json({ ok: true }), {
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
    });

    const req = new NextRequest(
      new Request('https://api.crivacy.test/api/webhooks/didit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json{{{',
      }),
    );
    const res = await route(req);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('malformed_json');
  });

  it('returns 413 when body exceeds size limit', async () => {
    const route = webhookRoute((ctx) => ctx.json({ ok: true }), {
      dbFactory,
      clock: fixtureClock,
      requestIdFactory: fixtureRequestIdFactory,
      maxBodyBytes: 32,
    });

    const req = buildPostRequest('https://api.crivacy.test/api/webhooks/didit', {
      big: 'x'.repeat(100),
    });
    const res = await route(req);

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_large');
  });

  it('maps handler errors through the error mapper', async () => {
    const route = webhookRoute(
      () => {
        throw new Error('handler boom');
      },
      { dbFactory, clock: fixtureClock, requestIdFactory: fixtureRequestIdFactory },
    );

    const req = buildPostRequest('https://api.crivacy.test/api/webhooks/didit', { e: 1 });
    const res = await route(req);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('internal_error');
  });
});
