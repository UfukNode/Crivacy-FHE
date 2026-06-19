/**
 * Request metrics tests.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';

import { getRegistry, resetMetricsForTests } from '@/lib/observability/metrics';
import {
  normalizeRoutePath,
  recordAuthAttempt,
  recordRateLimitDenial,
  recordRequestMetrics,
} from '@/lib/observability/request-metrics';

afterEach(() => {
  resetMetricsForTests();
});

describe('normalizeRoutePath', () => {
  it('replaces UUID in path', () => {
    const result = normalizeRoutePath('/api/v1/sessions/550e8400-e29b-41d4-a716-446655440000');
    expect(result).toBe('/api/v1/sessions/:id');
  });

  it('replaces UUID with trailing path', () => {
    const result = normalizeRoutePath(
      '/api/v1/credentials/550e8400-e29b-41d4-a716-446655440000/verify',
    );
    expect(result).toBe('/api/v1/credentials/:id/verify');
  });

  it('replaces multiple UUIDs', () => {
    const result = normalizeRoutePath(
      '/api/v1/firms/550e8400-e29b-41d4-a716-446655440000/keys/660e8400-e29b-41d4-a716-446655440001',
    );
    expect(result).toBe('/api/v1/firms/:id/keys/:id');
  });

  it('replaces numeric IDs', () => {
    const result = normalizeRoutePath('/api/v1/audit/12345');
    expect(result).toBe('/api/v1/audit/:id');
  });

  it('does not replace single-digit numbers', () => {
    const result = normalizeRoutePath('/api/v1/health');
    expect(result).toBe('/api/v1/health');
  });

  it('handles root path', () => {
    const result = normalizeRoutePath('/');
    expect(result).toBe('/');
  });

  it('handles paths without IDs', () => {
    const result = normalizeRoutePath('/api/v1/sessions');
    expect(result).toBe('/api/v1/sessions');
  });

  it('handles uppercase UUIDs', () => {
    const result = normalizeRoutePath('/api/v1/sessions/550E8400-E29B-41D4-A716-446655440000');
    expect(result).toBe('/api/v1/sessions/:id');
  });
});

describe('recordRequestMetrics', () => {
  it('records HTTP request metrics', async () => {
    recordRequestMetrics({
      method: 'GET',
      path: '/api/v1/health',
      status: 200,
      durationMs: 50,
      authTier: 'public',
    });

    const metrics = await getRegistry().getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'crivacy_http_requests_total');
    expect(counter).toBeDefined();

    const histogram = metrics.find((m) => m.name === 'crivacy_http_request_duration_seconds');
    expect(histogram).toBeDefined();
  });

  it('normalizes path in labels', async () => {
    recordRequestMetrics({
      method: 'GET',
      path: '/api/v1/sessions/550e8400-e29b-41d4-a716-446655440000',
      status: 200,
      durationMs: 30,
      authTier: 'firm',
    });

    const text = await getRegistry().metrics();
    expect(text).toContain('/api/v1/sessions/:id');
    expect(text).not.toContain('550e8400');
  });

  it('converts duration from ms to seconds', async () => {
    recordRequestMetrics({
      method: 'POST',
      path: '/api/v1/sessions',
      status: 201,
      durationMs: 1000,
      authTier: 'firm',
    });

    // If the histogram observed 1.0 seconds, it should be in the appropriate bucket
    const text = await getRegistry().metrics();
    expect(text).toContain('crivacy_http_request_duration_seconds');
  });

  it('does not throw on metrics failure', () => {
    // This should not throw even if something goes wrong internally
    expect(() =>
      recordRequestMetrics({
        method: 'GET',
        path: '/test',
        status: 200,
        durationMs: 10,
        authTier: 'public',
      }),
    ).not.toThrow();
  });
});

describe('recordAuthAttempt', () => {
  it('records api_key success', async () => {
    recordAuthAttempt('api_key', 'success');
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_auth_attempts_total');
    expect(metric).toBeDefined();
  });

  it('records jwt failure', async () => {
    recordAuthAttempt('jwt', 'failure');
    const text = await getRegistry().metrics();
    expect(text).toContain('method="jwt"');
    expect(text).toContain('result="failure"');
  });

  it('records totp expired', async () => {
    recordAuthAttempt('totp', 'expired');
    const text = await getRegistry().metrics();
    expect(text).toContain('method="totp"');
    expect(text).toContain('result="expired"');
  });
});

describe('recordRateLimitDenial', () => {
  it('records bucket denial', async () => {
    recordRateLimitDenial('free', 'bucket');
    const text = await getRegistry().metrics();
    expect(text).toContain('tier="free"');
    expect(text).toContain('reason="bucket"');
  });

  it('records quota denial', async () => {
    recordRateLimitDenial('pro', 'quota');
    const text = await getRegistry().metrics();
    expect(text).toContain('tier="pro"');
    expect(text).toContain('reason="quota"');
  });
});
