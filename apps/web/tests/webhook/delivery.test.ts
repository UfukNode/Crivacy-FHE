/**
 * Tests for webhook delivery execution.
 */

import { describe, expect, it } from 'vitest';

import { executeDelivery, isTransientFailure } from '@/lib/webhook';

import {
  FIXTURE_DELIVERY_ID,
  FIXTURE_EVENT_ID,
  FIXTURE_SIGNING_SECRET,
  FIXTURE_TIMESTAMP,
  FIXTURE_WEBHOOK_URL,
  buildFakeFetch,
} from './fixtures';

function buildInput() {
  return {
    url: FIXTURE_WEBHOOK_URL,
    body: '{"type":"credential.created"}',
    secret: FIXTURE_SIGNING_SECRET,
    eventId: FIXTURE_EVENT_ID,
    deliveryId: FIXTURE_DELIVERY_ID,
    timestamp: FIXTURE_TIMESTAMP,
  };
}

describe('executeDelivery', () => {
  it('returns success on 200', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 200, body: '{"ok":true}' });

    const result = await executeDelivery(buildInput(), 5000, 1024, ff.fetch);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.httpStatus).toBe(200);
      expect(result.responseBodySample).toBe('{"ok":true}');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('passes redirect: error so redirects are never followed (SSRF guard, AUDIT H-1)', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 200, body: '{"ok":true}' });

    await executeDelivery(buildInput(), 5000, 1024, ff.fetch);

    expect(ff.calls).toHaveLength(1);
    expect(ff.calls[0]?.redirect).toBe('error');
  });

  it('treats a redirect as a failure instead of following the hop', async () => {
    // Under redirect: 'error', undici rejects with a TypeError when the
    // server answers with a 3xx. The delivery must surface that as a
    // failure and never follow the Location header (which could point at
    // internal/metadata addresses, bypassing the SSRF guard).
    const ff = buildFakeFetch();
    ff.enqueueError(new TypeError('unexpected redirect'));

    const result = await executeDelivery(buildInput(), 5000, 1024, ff.fetch);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.httpStatus).toBeNull();
    }
  });

  it('returns success on 204', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 204, body: '' });

    const result = await executeDelivery(buildInput(), 5000, 1024, ff.fetch);
    expect(result.success).toBe(true);
  });

  it('returns failure on 500', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 500, statusText: 'Internal Server Error', body: 'Error' });

    const result = await executeDelivery(buildInput(), 5000, 1024, ff.fetch);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.httpStatus).toBe(500);
      expect(result.error).toContain('500');
      expect(result.responseBodySample).toBe('Error');
    }
  });

  it('returns failure on 404', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 404, statusText: 'Not Found', body: 'Not Found' });

    const result = await executeDelivery(buildInput(), 5000, 1024, ff.fetch);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.httpStatus).toBe(404);
    }
  });

  it('truncates long response bodies', async () => {
    const ff = buildFakeFetch();
    const longBody = 'x'.repeat(2000);
    ff.enqueue({ status: 200, body: longBody });

    const result = await executeDelivery(buildInput(), 5000, 100, ff.fetch);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.responseBodySample.length).toBeLessThan(2000);
      expect(result.responseBodySample).toContain('[truncated]');
    }
  });

  it('handles network errors', async () => {
    const ff = buildFakeFetch();
    ff.enqueueError(new Error('connection refused'));

    const result = await executeDelivery(buildInput(), 5000, 1024, ff.fetch);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.httpStatus).toBeNull();
      expect(result.error).toContain('Network error');
      expect(result.error).toContain('connection refused');
    }
  });

  it('handles abort/timeout errors', async () => {
    const ff = buildFakeFetch();
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    ff.enqueueError(abortErr);

    const result = await executeDelivery(buildInput(), 5000, 1024, ff.fetch);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.httpStatus).toBeNull();
      expect(result.error).toContain('timed out');
    }
  });

  it('sends correct headers', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 200, body: '' });

    await executeDelivery(buildInput(), 5000, 1024, ff.fetch);

    expect(ff.calls.length).toBe(1);
    const call = ff.calls[0];
    if (call === undefined) throw new Error('expected delivery call');
    expect(call.method).toBe('POST');
    expect(call.url).toBe(FIXTURE_WEBHOOK_URL);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['x-crivacy-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(call.headers['x-crivacy-event-id']).toBe(FIXTURE_EVENT_ID);
    expect(call.headers['x-crivacy-delivery-id']).toBe(FIXTURE_DELIVERY_ID);
    expect(call.headers['user-agent']).toBe('Crivacy-Webhook/1.0');
  });

  it('measures latency', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 200, body: '' });

    let callCount = 0;
    const clock = () => {
      callCount++;
      return callCount === 1 ? 1000 : 1150;
    };

    const result = await executeDelivery(buildInput(), 5000, 1024, ff.fetch, clock);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.latencyMs).toBe(150);
    }
  });
});

describe('isTransientFailure', () => {
  it('returns false for success', () => {
    expect(
      isTransientFailure({
        success: true,
        httpStatus: 200,
        latencyMs: 100,
        responseBodySample: '',
      }),
    ).toBe(false);
  });

  it('returns true for null httpStatus (network error)', () => {
    expect(
      isTransientFailure({
        success: false,
        httpStatus: null,
        error: 'network',
        latencyMs: 100,
        responseBodySample: null,
      }),
    ).toBe(true);
  });

  it('returns true for 500', () => {
    expect(
      isTransientFailure({
        success: false,
        httpStatus: 500,
        error: '500',
        latencyMs: 100,
        responseBodySample: null,
      }),
    ).toBe(true);
  });

  it('returns true for 502', () => {
    expect(
      isTransientFailure({
        success: false,
        httpStatus: 502,
        error: '502',
        latencyMs: 100,
        responseBodySample: null,
      }),
    ).toBe(true);
  });

  it('returns true for 429', () => {
    expect(
      isTransientFailure({
        success: false,
        httpStatus: 429,
        error: '429',
        latencyMs: 100,
        responseBodySample: null,
      }),
    ).toBe(true);
  });

  it('returns false for 400 (permanent)', () => {
    expect(
      isTransientFailure({
        success: false,
        httpStatus: 400,
        error: '400',
        latencyMs: 100,
        responseBodySample: null,
      }),
    ).toBe(false);
  });

  it('returns false for 404 (permanent)', () => {
    expect(
      isTransientFailure({
        success: false,
        httpStatus: 404,
        error: '404',
        latencyMs: 100,
        responseBodySample: null,
      }),
    ).toBe(false);
  });

  it('returns false for 401 (permanent)', () => {
    expect(
      isTransientFailure({
        success: false,
        httpStatus: 401,
        error: '401',
        latencyMs: 100,
        responseBodySample: null,
      }),
    ).toBe(false);
  });
});
