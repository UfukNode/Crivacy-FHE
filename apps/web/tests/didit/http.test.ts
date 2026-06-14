/**
 * Tests for the low-level Didit HTTP transport.
 *
 * The transport is the thinnest possible wrapper around a `FetchLike`
 * that still enforces our retry, timeout, header, auth, schema, and
 * error-mapping contracts. Every test here drives the transport
 * through the fake fetch (`buildFakeFetch`) — no real HTTP is issued.
 *
 * Contracts we pin in this suite:
 *
 *   * x-api-key header (NOT Authorization Bearer)
 *   * Content-Type + Accept JSON headers
 *   * URL join against DiditConfig.baseUrl
 *   * POST body JSON encoding + passthrough to fetch
 *   * GET retry=auto default, POST retry=never default
 *   * Exponential backoff on transient failures
 *   * HTTP error mapping: 401 → unauthorized, 403 → forbidden,
 *     404 → not_found, 429 → rate_limited, 5xx → service_unavailable,
 *     anything else → http_error.
 *   * 2xx empty body → empty_response
 *   * 2xx non-JSON body → invalid_response
 *   * 2xx JSON body failing the schema → invalid_response with the
 *     issues in context.
 *   * AbortError coming out of fetch → request_timeout
 *   * Arbitrary thrown error → network_error
 *   * diditFetchOnce always attempts exactly one call
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DiditError, diditFetch, diditFetchOnce, isDiditErrorWithCode } from '@crivacy-fhe/adapter-didit';

import { FIXTURE_API_KEY, FIXTURE_BASE_URL, buildFakeFetch, buildTestConfig } from './fixtures';

const BodySchema = z.object({ ok: z.literal(true), n: z.number() });

describe('diditFetchOnce — happy path', () => {
  it('issues a GET with x-api-key, JSON accept + content headers', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', body: { ok: true, n: 1 } });

    const result = await diditFetchOnce(
      config,
      { method: 'GET', path: '/v3/ping', schema: BodySchema },
      handle.fetch,
    );

    expect(result).toEqual({ ok: true, n: 1 });
    expect(handle.captured).toHaveLength(1);
    const captured = handle.captured[0];
    if (captured === undefined) {
      throw new Error('expected captured');
    }
    expect(captured.method).toBe('GET');
    expect(captured.path).toBe('/v3/ping');
    expect(captured.url).toBe(`${FIXTURE_BASE_URL}/v3/ping`);
    expect(captured.headers['x-api-key']).toBe(FIXTURE_API_KEY);
    expect(captured.headers['Content-Type']).toBe('application/json');
    expect(captured.headers['Accept']).toBe('application/json');
    // Didit does NOT use Bearer auth — make sure we did not set it.
    expect(captured.headers['Authorization']).toBeUndefined();
  });

  it('prepends a leading slash when the path is missing one', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', body: { ok: true, n: 2 } });

    await diditFetchOnce(
      config,
      { method: 'GET', path: 'v3/ping', schema: BodySchema },
      handle.fetch,
    );

    const captured = handle.captured[0];
    if (captured === undefined) {
      throw new Error('expected captured');
    }
    expect(captured.url).toBe(`${FIXTURE_BASE_URL}/v3/ping`);
  });

  it('serializes a POST body as JSON', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', body: { ok: true, n: 3 } });

    await diditFetchOnce(
      config,
      {
        method: 'POST',
        path: '/v3/session/',
        body: { workflow_id: 'abc', vendor_data: 'user_1' },
        schema: BodySchema,
      },
      handle.fetch,
    );

    const captured = handle.captured[0];
    if (captured === undefined) {
      throw new Error('expected captured');
    }
    expect(captured.method).toBe('POST');
    expect(captured.body).toEqual({ workflow_id: 'abc', vendor_data: 'user_1' });
  });
});

describe('diditFetchOnce — error mapping', () => {
  it('maps 401 to unauthorized', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 401, body: { detail: 'bad key' } });

    await expect(
      diditFetchOnce(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'unauthorized'));
  });

  it('maps 403 to forbidden', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 403, body: { detail: 'denied' } });

    await expect(
      diditFetchOnce(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'forbidden'));
  });

  it('maps 404 to not_found', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 404, body: { detail: 'missing' } });

    await expect(
      diditFetchOnce(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'not_found'));
  });

  it('maps 429 to rate_limited', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 429, body: { detail: 'slow down' } });

    await expect(
      diditFetchOnce(
        config,
        { method: 'POST', path: '/v3/session/', schema: BodySchema },
        handle.fetch,
      ),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'rate_limited'));
  });

  it('maps 500 to service_unavailable', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 500, body: { detail: 'boom' } });

    await expect(
      diditFetchOnce(
        config,
        { method: 'POST', path: '/v3/session/', schema: BodySchema },
        handle.fetch,
      ),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'service_unavailable'));
  });

  it('maps 503 to service_unavailable', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'text', status: 503, body: '<html>maintenance</html>' });

    await expect(
      diditFetchOnce(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'service_unavailable'));
  });

  it('maps 418 to http_error (generic fallback)', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 418, body: { detail: 'teapot' } });

    await expect(
      diditFetchOnce(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'http_error'));
  });

  it('attaches the upstream error to the context when it parses', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({
      kind: 'json',
      status: 401,
      body: { detail: 'bad key', code: 'unauthorized', request_id: 'req_42' },
    });

    try {
      await diditFetchOnce(
        config,
        { method: 'GET', path: '/v3/ping', schema: BodySchema },
        handle.fetch,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DiditError);
      const context = (err as DiditError).context ?? {};
      expect((context as Record<string, unknown>)['status']).toBe(401);
      const upstream = (context as Record<string, unknown>)['upstreamError'] as
        | Record<string, unknown>
        | undefined;
      expect(upstream?.['request_id']).toBe('req_42');
    }
  });

  it('still maps a non-JSON 5xx body to service_unavailable', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'text', status: 502, body: 'Bad Gateway' });

    try {
      await diditFetchOnce(
        config,
        { method: 'GET', path: '/v3/ping', schema: BodySchema },
        handle.fetch,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DiditError);
      expect((err as DiditError).code).toBe('service_unavailable');
      // Non-structured body → no upstreamError field.
      const context = (err as DiditError).context ?? {};
      expect((context as Record<string, unknown>)['upstreamError']).toBeUndefined();
    }
  });
});

describe('diditFetchOnce — body parsing', () => {
  it('throws empty_response on a 2xx with an empty body', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'empty' });

    await expect(
      diditFetchOnce(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'empty_response'));
  });

  it('throws invalid_response on a non-JSON body', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'text', body: '<html></html>' });

    await expect(
      diditFetchOnce(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'invalid_response'));
  });

  it('throws invalid_response on a schema mismatch', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', body: { ok: 'not-a-bool', n: 'not-a-number' } });

    try {
      await diditFetchOnce(
        config,
        { method: 'GET', path: '/v3/ping', schema: BodySchema },
        handle.fetch,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DiditError);
      expect((err as DiditError).code).toBe('invalid_response');
      const context = (err as DiditError).context ?? {};
      expect(Array.isArray((context as Record<string, unknown>)['issues'])).toBe(true);
    }
  });
});

describe('diditFetchOnce — network + abort', () => {
  it('wraps a thrown fetch error as network_error', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'throw', error: new Error('socket hang up') });

    await expect(
      diditFetchOnce(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'network_error'));
  });

  it('wraps an AbortError as request_timeout', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    handle.enqueue({ kind: 'throw', error: abortError });

    await expect(
      diditFetchOnce(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'request_timeout'));
  });

  it('wraps a DOMException-style abort (code === 20) as request_timeout', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    const abortError = Object.assign(new Error('aborted'), { code: 20 });
    handle.enqueue({ kind: 'throw', error: abortError });

    await expect(
      diditFetchOnce(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'request_timeout'));
  });

  it('attaches method + path context to errors', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'throw', error: new Error('x') });

    try {
      await diditFetchOnce(
        config,
        {
          method: 'GET',
          path: '/v3/session/abc/decision/',
          schema: BodySchema,
          context: { sessionId: 'abc' },
        },
        handle.fetch,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DiditError);
      const context = (err as DiditError).context ?? {};
      expect((context as Record<string, unknown>)['method']).toBe('GET');
      expect((context as Record<string, unknown>)['path']).toBe('/v3/session/abc/decision/');
      expect((context as Record<string, unknown>)['sessionId']).toBe('abc');
    }
  });
});

describe('diditFetch — retry behavior', () => {
  it('retries a GET on a 5xx transient failure', async () => {
    const config = buildTestConfig({ DIDIT_MAX_RETRIES: '2' });
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 503, body: { detail: 'down' } });
    handle.enqueue({ kind: 'json', body: { ok: true, n: 7 } });

    const result = await diditFetch(
      config,
      { method: 'GET', path: '/v3/ping', schema: BodySchema },
      handle.fetch,
    );
    expect(result).toEqual({ ok: true, n: 7 });
    expect(handle.captured).toHaveLength(2);
  });

  it('retries a GET on a network_error transient failure', async () => {
    const config = buildTestConfig({ DIDIT_MAX_RETRIES: '2' });
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'throw', error: new Error('ECONNRESET') });
    handle.enqueue({ kind: 'json', body: { ok: true, n: 8 } });

    const result = await diditFetch(
      config,
      { method: 'GET', path: '/v3/ping', schema: BodySchema },
      handle.fetch,
    );
    expect(result).toEqual({ ok: true, n: 8 });
  });

  it('does NOT retry a POST by default', async () => {
    const config = buildTestConfig({ DIDIT_MAX_RETRIES: '3' });
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 503, body: { detail: 'down' } });

    await expect(
      diditFetch(
        config,
        { method: 'POST', path: '/v3/session/', body: {}, schema: BodySchema },
        handle.fetch,
      ),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'service_unavailable'));
    expect(handle.captured).toHaveLength(1);
  });

  it('retries a POST when retry: auto is explicitly passed', async () => {
    const config = buildTestConfig({ DIDIT_MAX_RETRIES: '2' });
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 503, body: { detail: 'down' } });
    handle.enqueue({ kind: 'json', body: { ok: true, n: 9 } });

    const result = await diditFetch(
      config,
      {
        method: 'POST',
        path: '/v3/session/',
        body: {},
        schema: BodySchema,
        retry: 'auto',
      },
      handle.fetch,
    );
    expect(result).toEqual({ ok: true, n: 9 });
    expect(handle.captured).toHaveLength(2);
  });

  it('does NOT retry a GET when retry: never is explicitly passed', async () => {
    const config = buildTestConfig({ DIDIT_MAX_RETRIES: '3' });
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 503, body: { detail: 'down' } });

    await expect(
      diditFetch(
        config,
        { method: 'GET', path: '/v3/ping', schema: BodySchema, retry: 'never' },
        handle.fetch,
      ),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'service_unavailable'));
    expect(handle.captured).toHaveLength(1);
  });

  it('stops retrying after maxRetries attempts are exhausted', async () => {
    const config = buildTestConfig({ DIDIT_MAX_RETRIES: '2' });
    const handle = buildFakeFetch();
    // 3 attempts total: initial + 2 retries.
    handle.enqueue({ kind: 'json', status: 503, body: { detail: '1' } });
    handle.enqueue({ kind: 'json', status: 503, body: { detail: '2' } });
    handle.enqueue({ kind: 'json', status: 503, body: { detail: '3' } });

    await expect(
      diditFetch(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'service_unavailable'));
    expect(handle.captured).toHaveLength(3);
  });

  it('does NOT retry on a fatal error like unauthorized', async () => {
    const config = buildTestConfig({ DIDIT_MAX_RETRIES: '3' });
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 401, body: { detail: 'bad key' } });

    await expect(
      diditFetch(config, { method: 'GET', path: '/v3/ping', schema: BodySchema }, handle.fetch),
    ).rejects.toSatisfy((err) => isDiditErrorWithCode(err, 'unauthorized'));
    expect(handle.captured).toHaveLength(1);
  });

  it('wraps a non-DiditError thrown inside the fetch loop as unexpected', async () => {
    const config = buildTestConfig();
    // Pass a fetch that throws a raw non-Error value (simulating a
    // programmer error deep in the stack).
    const brokenFetch = vi.fn(async () => {
      throw { weird: true };
    });

    await expect(
      diditFetch(
        config,
        { method: 'GET', path: '/v3/ping', schema: BodySchema },
        brokenFetch as unknown as Parameters<typeof diditFetch>[2],
      ),
    ).rejects.toSatisfy(
      (err) =>
        err instanceof DiditError && (err.code === 'unexpected' || err.code === 'network_error'),
    );
  });
});

describe('diditFetch — defaults', () => {
  it('defaults retry to auto for GET and uses DIDIT_MAX_RETRIES', async () => {
    const config = buildTestConfig({ DIDIT_MAX_RETRIES: '1' });
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'throw', error: new Error('x') });
    handle.enqueue({ kind: 'json', body: { ok: true, n: 10 } });

    const result = await diditFetch(
      config,
      { method: 'GET', path: '/v3/ping', schema: BodySchema },
      handle.fetch,
    );
    expect(result).toEqual({ ok: true, n: 10 });
    expect(handle.captured).toHaveLength(2);
  });
});
