import { describe, expect, it, vi } from 'vitest';

import { handlePlaygroundExecute } from '../../../src/server/handlers/dashboard-playground';
import { buildDashboardCtx } from './dashboard-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDeps(
  overrides: {
    apiKey?: { id: string; prefix: string; keyHash: string; mode: string } | null;
    fetchResponse?: { ok: boolean; status: number; statusText: string; body: unknown };
    fetchError?: Error;
  } = {},
) {
  const defaultApiKey = {
    id: 'key-1',
    prefix: 'crv_test_abcd1234',
    keyHash: '$2a$04$abc',
    mode: 'test',
  };
  const findApiKeyForPlayground = vi
    .fn()
    .mockResolvedValue('apiKey' in overrides ? overrides.apiKey : defaultApiKey);

  const mockHeaders = new Map<string, string>([
    ['content-type', 'application/json'],
    ['x-ratelimit-limit', '100'],
  ]);

  const mockFetch = vi.fn().mockImplementation(() => {
    if (overrides.fetchError !== undefined) {
      return Promise.reject(overrides.fetchError);
    }
    const resp = overrides.fetchResponse ?? {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: { data: 'test' },
    };
    return Promise.resolve({
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: {
        forEach: (cb: (value: string, key: string) => void) => {
          mockHeaders.forEach((v, k) => cb(v, k));
        },
      },
      text: () => Promise.resolve(JSON.stringify(resp.body)),
    });
  });

  return {
    deps: {
      findApiKeyForPlayground,
      resolveBaseUrl: () => 'http://localhost:3001',
      fetchImpl: mockFetch as unknown as typeof globalThis.fetch,
    },
    findApiKeyForPlayground,
    mockFetch,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handlePlaygroundExecute', () => {
  it('rejects paths not starting with /api/v1/', async () => {
    const { deps } = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handlePlaygroundExecute(
      deps,
      ctx,
      { method: 'GET', path: '/api/internal/firm' },
      'key-1',
    );
    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>)['error']).toMatchObject({
      code: 'invalid_path',
    });
  });

  it('returns 404 when API key not found', async () => {
    const { deps } = buildDeps({ apiKey: null });
    const ctx = buildDashboardCtx();
    const result = await handlePlaygroundExecute(
      deps,
      ctx,
      { method: 'GET', path: '/api/v1/health' },
      'nonexistent-key',
    );
    expect(result.status).toBe(404);
    expect((result.body as Record<string, unknown>)['error']).toMatchObject({
      code: 'api_key_not_found',
    });
  });

  it('proxies GET request successfully', async () => {
    const { deps, mockFetch } = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handlePlaygroundExecute(
      deps,
      ctx,
      { method: 'GET', path: '/api/v1/health' },
      'key-1',
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: 'test' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockFetch).toHaveBeenCalledOnce();

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe('http://localhost:3001/api/v1/health');
    expect(callArgs[1]?.method).toBe('GET');
  });

  it('proxies POST request with body', async () => {
    const { deps, mockFetch } = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handlePlaygroundExecute(
      deps,
      ctx,
      {
        method: 'POST',
        path: '/api/v1/sessions',
        body: { userRef: 'test-user' },
      },
      'key-1',
    );
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(callArgs[1]?.body).toBe(JSON.stringify({ userRef: 'test-user' }));
  });

  it('filters blocked headers from user input', async () => {
    const { deps, mockFetch } = buildDeps();
    const ctx = buildDashboardCtx();
    await handlePlaygroundExecute(
      deps,
      ctx,
      {
        method: 'GET',
        path: '/api/v1/health',
        headers: {
          'X-Custom': 'allowed',
          Authorization: 'should-be-blocked',
          Host: 'should-be-blocked',
          Cookie: 'should-be-blocked',
        },
      },
      'key-1',
    );

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers['x-custom']).toBe('allowed');
    expect(headers['authorization']).toBeUndefined();
    expect(headers['host']).toBeUndefined();
    expect(headers['cookie']).toBeUndefined();
  });

  it('rejects oversized body', async () => {
    const { deps } = buildDeps();
    const ctx = buildDashboardCtx();
    const largeBody = { data: 'x'.repeat(70_000) };
    const result = await handlePlaygroundExecute(
      deps,
      ctx,
      { method: 'POST', path: '/api/v1/sessions', body: largeBody },
      'key-1',
    );
    expect(result.status).toBe(413);
    expect((result.body as Record<string, unknown>)['error']).toMatchObject({
      code: 'payload_too_large',
    });
  });

  it('handles network error gracefully', async () => {
    const { deps } = buildDeps({ fetchError: new Error('connection refused') });
    const ctx = buildDashboardCtx();
    const result = await handlePlaygroundExecute(
      deps,
      ctx,
      { method: 'GET', path: '/api/v1/health' },
      'key-1',
    );
    expect(result.status).toBe(502);
    expect((result.body as Record<string, unknown>)['error']).toMatchObject({
      code: 'proxy_error',
    });
  });

  it('handles abort/timeout gracefully', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const { deps } = buildDeps({ fetchError: abortError });
    const ctx = buildDashboardCtx();
    const result = await handlePlaygroundExecute(
      deps,
      ctx,
      { method: 'GET', path: '/api/v1/health' },
      'key-1',
    );
    expect(result.status).toBe(502);
    const errBody = (result.body as Record<string, unknown>)['error'] as Record<string, unknown>;
    expect(errBody['message']).toContain('timed out');
  });

  it('only forwards safe response headers', async () => {
    const { deps } = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handlePlaygroundExecute(
      deps,
      ctx,
      { method: 'GET', path: '/api/v1/health' },
      'key-1',
    );
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers['x-ratelimit-limit']).toBe('100');
  });

  it('verifies API key belongs to the firm', async () => {
    const { deps, findApiKeyForPlayground } = buildDeps();
    const ctx = buildDashboardCtx();
    await handlePlaygroundExecute(deps, ctx, { method: 'GET', path: '/api/v1/health' }, 'key-1');
    expect(findApiKeyForPlayground).toHaveBeenCalledWith(ctx.db, 'key-1', ctx.firm.id);
  });
});
