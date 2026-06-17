/**
 * Tests for the webhook delivery worker — processDelivery logic.
 *
 * Uses mock repository + mock fetch to test the core delivery flow
 * without hitting a real DB or HTTP endpoint.
 */

import { describe, expect, it, vi } from 'vitest';

import { seal } from '@/lib/auth/crypto-box';
import type { CrivacyDatabase } from '@/lib/db/client';
import type {
  DeliveryRow,
  EndpointRow,
  EventRow,
  WorkerDeps,
  WorkerRepository,
} from '@/server/jobs/webhook-worker';
import { processDelivery } from '@/server/jobs/webhook-worker';

import {
  FIXTURE_DELIVERY_ID,
  FIXTURE_ENCRYPTION_KEY_BASE64,
  FIXTURE_ENDPOINT_ID,
  FIXTURE_EVENT_ID,
  FIXTURE_FIRM_ID,
  FIXTURE_NOW,
  FIXTURE_SIGNING_SECRET,
  FIXTURE_WEBHOOK_URL,
  buildFakeFetch,
  buildTestConfig,
} from './fixtures';

/* ---------- Helpers ---------- */

function buildDeliveryRow(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: FIXTURE_DELIVERY_ID,
    endpointId: FIXTURE_ENDPOINT_ID,
    eventId: FIXTURE_EVENT_ID,
    status: 'pending',
    attempts: 0,
    maxAttempts: 7,
    ...overrides,
  };
}

function buildEndpointRow(overrides: Partial<EndpointRow> = {}): EndpointRow {
  const key = Buffer.from(FIXTURE_ENCRYPTION_KEY_BASE64, 'base64');
  const sealed = seal(FIXTURE_SIGNING_SECRET, key, 1);

  // Combine ciphertext + tag into one buffer (our storage format)
  const ciphertext = new Uint8Array(Buffer.concat([sealed.ciphertext, sealed.tag]));

  return {
    id: FIXTURE_ENDPOINT_ID,
    url: FIXTURE_WEBHOOK_URL,
    signingSecretCiphertext: ciphertext,
    signingSecretNonce: new Uint8Array(sealed.nonce),
    signingKeyVersion: 1,
    consecutiveFailures: 0,
    circuitBreakerTrippedAt: null,
    disabledAt: null,
    ...overrides,
  };
}

function buildEventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: FIXTURE_EVENT_ID,
    firmId: FIXTURE_FIRM_ID,
    type: 'credential.created',
    payload: { contractId: 'cid-001' },
    sourceSessionId: null,
    createdAt: FIXTURE_NOW,
    ...overrides,
  };
}

function buildMockRepo(overrides: Partial<WorkerRepository> = {}): WorkerRepository {
  return {
    findDeliveryById: vi.fn().mockResolvedValue(buildDeliveryRow()),
    findEndpointByIdUnscoped: vi.fn().mockResolvedValue(buildEndpointRow()),
    findEventById: vi.fn().mockResolvedValue(buildEventRow()),
    markDelivering: vi.fn().mockResolvedValue(undefined),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markDeadLettered: vi.fn().mockResolvedValue(undefined),
    updateEndpointCircuitBreaker: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function buildDeps(
  fetchQueue: ReturnType<typeof buildFakeFetch>,
  overrides: Partial<WorkerDeps> = {},
): WorkerDeps {
  return {
    db: {} as CrivacyDatabase,
    config: buildTestConfig(),
    fetchImpl: fetchQueue.fetch,
    clock: () => FIXTURE_NOW,
    clockMs: () => FIXTURE_NOW.getTime(),
    // Default SSRF guard: always allow. Individual cases that need
    // to exercise the guard reject-path override this via `overrides`.
    // Production leaves `urlGuard` unset so the real DNS-based check
    // runs.
    urlGuard: async () => ({ ok: true, normalised: FIXTURE_WEBHOOK_URL }),
    ...overrides,
  };
}

/* ---------- Tests ---------- */

describe('processDelivery', () => {
  it('delivers successfully on 200 response', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 200, body: '{"ok":true}' });

    const repo = buildMockRepo();
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.markDelivering).toHaveBeenCalledOnce();
    expect(repo.markDelivered).toHaveBeenCalledOnce();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.markDeadLettered).not.toHaveBeenCalled();

    // Circuit breaker should be reset on success
    expect(repo.updateEndpointCircuitBreaker).toHaveBeenCalledWith(
      expect.anything(),
      FIXTURE_ENDPOINT_ID,
      expect.objectContaining({ consecutiveFailures: 0 }),
    );
  });

  it('marks failed and schedules retry on 500', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 500, statusText: 'Internal Server Error', body: 'Error' });

    const repo = buildMockRepo();
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.markDelivering).toHaveBeenCalledOnce();
    expect(repo.markFailed).toHaveBeenCalledOnce();
    expect(repo.markDelivered).not.toHaveBeenCalled();
    expect(repo.markDeadLettered).not.toHaveBeenCalled();

    // Should schedule next retry
    const failCall = vi.mocked(repo.markFailed).mock.calls[0];
    if (failCall === undefined) throw new Error('expected markFailed call');
    expect(failCall[2]).toBe(1); // attempts = 1
    expect(failCall[6]).toBeInstanceOf(Date); // nextRetryAt is set
  });

  it('dead-letters after max attempts', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 500, statusText: 'Error', body: 'Error' });

    const repo = buildMockRepo({
      findDeliveryById: vi
        .fn()
        .mockResolvedValue(buildDeliveryRow({ attempts: 6, maxAttempts: 7 })),
    });
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.markDeadLettered).toHaveBeenCalledOnce();
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('dead-letters on permanent 4xx failure', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 404, statusText: 'Not Found', body: 'Not Found' });

    const repo = buildMockRepo();
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    // 404 is not transient, so dead-letter immediately
    expect(repo.markDeadLettered).toHaveBeenCalledOnce();
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('skips already delivered deliveries', async () => {
    const ff = buildFakeFetch();
    const repo = buildMockRepo({
      findDeliveryById: vi.fn().mockResolvedValue(buildDeliveryRow({ status: 'delivered' })),
    });
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.markDelivering).not.toHaveBeenCalled();
    expect(ff.calls.length).toBe(0);
  });

  it('skips dead-lettered deliveries', async () => {
    const ff = buildFakeFetch();
    const repo = buildMockRepo({
      findDeliveryById: vi.fn().mockResolvedValue(buildDeliveryRow({ status: 'dead_letter' })),
    });
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.markDelivering).not.toHaveBeenCalled();
  });

  it('skips when delivery not found', async () => {
    const ff = buildFakeFetch();
    const repo = buildMockRepo({
      findDeliveryById: vi.fn().mockResolvedValue(null),
    });
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.markDelivering).not.toHaveBeenCalled();
  });

  it('skips when endpoint not found', async () => {
    const ff = buildFakeFetch();
    const repo = buildMockRepo({
      findEndpointByIdUnscoped: vi.fn().mockResolvedValue(null),
    });
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.markDelivering).not.toHaveBeenCalled();
  });

  it('skips disabled endpoints', async () => {
    const ff = buildFakeFetch();
    const repo = buildMockRepo({
      findEndpointByIdUnscoped: vi
        .fn()
        .mockResolvedValue(buildEndpointRow({ disabledAt: FIXTURE_NOW })),
    });
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.markDelivering).not.toHaveBeenCalled();
  });

  it('skips when circuit breaker is open', async () => {
    const ff = buildFakeFetch();
    const repo = buildMockRepo({
      findEndpointByIdUnscoped: vi
        .fn()
        .mockResolvedValue(buildEndpointRow({ circuitBreakerTrippedAt: FIXTURE_NOW })),
    });
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.markDelivering).not.toHaveBeenCalled();
  });

  it('skips when event not found', async () => {
    const ff = buildFakeFetch();
    const repo = buildMockRepo({
      findEventById: vi.fn().mockResolvedValue(null),
    });
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.markDelivering).not.toHaveBeenCalled();
  });

  it('increments circuit breaker on failure', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 500, statusText: 'Error', body: '' });

    const repo = buildMockRepo({
      findEndpointByIdUnscoped: vi
        .fn()
        .mockResolvedValue(buildEndpointRow({ consecutiveFailures: 48 })),
    });
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.updateEndpointCircuitBreaker).toHaveBeenCalledWith(
      expect.anything(),
      FIXTURE_ENDPOINT_ID,
      expect.objectContaining({ consecutiveFailures: 49 }),
    );
  });

  it('trips circuit breaker at threshold', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 500, statusText: 'Error', body: '' });

    const repo = buildMockRepo({
      findEndpointByIdUnscoped: vi
        .fn()
        .mockResolvedValue(buildEndpointRow({ consecutiveFailures: 49 })),
    });
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(repo.updateEndpointCircuitBreaker).toHaveBeenCalledWith(
      expect.anything(),
      FIXTURE_ENDPOINT_ID,
      expect.objectContaining({
        consecutiveFailures: 50,
        circuitBreakerTrippedAt: FIXTURE_NOW,
      }),
    );
  });

  it('sends correct body in HTTP POST', async () => {
    const ff = buildFakeFetch();
    ff.enqueue({ status: 200, body: '' });

    const repo = buildMockRepo();
    const deps = buildDeps(ff);

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(ff.calls.length).toBe(1);
    const firstCall = ff.calls[0];
    if (firstCall === undefined || firstCall.body === undefined || firstCall.body === null)
      throw new Error('expected call with body');
    const body = JSON.parse(firstCall.body) as Record<string, unknown>;
    expect(body['id']).toBe(FIXTURE_DELIVERY_ID);
    expect(body['type']).toBe('credential.created');
    // `firmId` is deliberately omitted from the envelope — see
    // `lib/webhook/envelope.ts` header comment: the receiving firm
    // already knows its own identity from the signing key, and a
    // multi-recipient fan-out would have no single correct answer
    // for this field.
    expect(body['firmId']).toBeUndefined();
    expect(body['data']).toEqual({ contractId: 'cid-001' });
  });

  it('dead-letters without dialling when the SSRF guard rejects the URL', async () => {
    // Covers AUD-INT-AUTHZ-SSRF-001: create-time validation passed
    // (the endpoint is registered and live), but at delivery time the
    // hostname resolves to a private IP (DNS rebinding). The worker
    // must refuse to fetch, dead-letter the delivery (retrying a
    // poisoned hostname would just keep dialling it), and bump the
    // circuit breaker failure counter so repeated SSRF rejections
    // trip the endpoint off.
    const ff = buildFakeFetch();
    // No response queued — any fetch attempt would throw, which is
    // the assertion.
    const repo = buildMockRepo();
    const deps = buildDeps(ff, {
      urlGuard: async () => ({
        ok: false,
        reason: 'URL resolves to a private, loopback, or link-local address.',
      }),
    });

    await processDelivery(deps, repo, FIXTURE_DELIVERY_ID);

    expect(ff.calls.length).toBe(0);
    expect(repo.markDelivered).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.markDeadLettered).toHaveBeenCalledOnce();

    const deadLetterCall = vi.mocked(repo.markDeadLettered).mock.calls[0];
    if (deadLetterCall === undefined) throw new Error('expected markDeadLettered call');
    expect(deadLetterCall[2]).toBe(1); // attempts bumped to 1
    expect(deadLetterCall[3]).toBeNull(); // no httpStatus — never dialled
    expect(deadLetterCall[4]).toMatch(/^ssrf_blocked_at_delivery:/);

    // Circuit breaker should register the failure.
    expect(repo.updateEndpointCircuitBreaker).toHaveBeenCalledOnce();
    const cbCall = vi.mocked(repo.updateEndpointCircuitBreaker).mock.calls[0];
    if (cbCall === undefined) throw new Error('expected updateEndpointCircuitBreaker call');
    expect(cbCall[2].consecutiveFailures).toBe(1);
  });
});
