/**
 * Test fixtures for webhook module tests.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

import type { WebhookConfig } from '@/lib/webhook/config';
import type { DeliveryResult } from '@/lib/webhook/delivery';
import type { FanOutDeps, FanOutEndpoint } from '@/lib/webhook/fan-out';

/* ---------- Constants ---------- */

export const FIXTURE_NOW = new Date('2026-04-12T10:00:00.000Z');
export const FIXTURE_TIMESTAMP = Math.floor(FIXTURE_NOW.getTime() / 1000);
export const FIXTURE_DELIVERY_ID = 'd1111111-1111-4111-8111-111111111111';
export const FIXTURE_ENDPOINT_ID = 'e1111111-1111-4111-8111-111111111111';
export const FIXTURE_EVENT_ID = 'v1111111-1111-4111-8111-111111111111';
export const FIXTURE_FIRM_ID = 'f1111111-1111-4111-8111-111111111111';

export const FIXTURE_WEBHOOK_URL = 'https://hooks.example.com/crivacy';
export const FIXTURE_SIGNING_SECRET = 'whsec_abcdefghijklmnopqrstuvwxyz012345';

// 32-byte AES-256 key for test encryption
export const FIXTURE_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');

/* ---------- Config ---------- */

export function buildTestConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return Object.freeze({
    deliveryTimeoutMs: 5000,
    retryScheduleSeconds: Object.freeze([10, 60, 300, 1800, 7200, 21600, 86400]),
    concurrency: 5,
    circuitBreakerThreshold: 50,
    circuitBreakerWindowSeconds: 3600,
    responseBodyMaxBytes: 1024,
    encryptionKeyBase64: FIXTURE_ENCRYPTION_KEY_BASE64,
    pollIntervalSeconds: 5,
    ...overrides,
  });
}

/* ---------- Delivery results ---------- */

export function buildSuccessResult(overrides: Partial<DeliveryResult> = {}): DeliveryResult {
  return {
    success: true,
    httpStatus: 200,
    latencyMs: 150,
    responseBodySample: '{"ok":true}',
    ...overrides,
  } as DeliveryResult;
}

export function buildFailureResult(
  overrides: Partial<DeliveryResult & { success: false }> = {},
): DeliveryResult {
  return {
    success: false,
    httpStatus: 500,
    error: 'HTTP 500 Internal Server Error',
    latencyMs: 3000,
    responseBodySample: 'Internal Server Error',
    ...overrides,
  } as DeliveryResult;
}

/* ---------- Fan-out mocks ---------- */

export function buildFanOutEndpoints(count = 3): FanOutEndpoint[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ep-${String(i + 1).padStart(4, '0')}`,
    maxAttempts: 7,
  }));
}

export function buildMockFanOutDeps(
  endpoints: readonly FanOutEndpoint[] = buildFanOutEndpoints(),
): FanOutDeps & { createdDeliveries: { endpointId: string; eventId: string }[] } {
  const createdDeliveries: { endpointId: string; eventId: string }[] = [];

  return {
    createdDeliveries,
    findEndpoints: async () => endpoints,
    createDelivery: async (input) => {
      createdDeliveries.push({
        endpointId: input.endpointId,
        eventId: input.eventId,
      });
      return { id: `del-${input.endpointId}` };
    },
  };
}

/* ---------- Fake fetch ---------- */

export interface FakeFetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly redirect: RequestRedirect | undefined;
}

export interface FakeFetchQueue {
  readonly fetch: (
    input: string | URL,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;
  readonly calls: FakeFetchCall[];
  enqueue(response: { status: number; statusText?: string; body?: string }): void;
  enqueueError(err: Error): void;
}

export function buildFakeFetch(): FakeFetchQueue {
  const calls: FakeFetchCall[] = [];
  const queue: Array<
    | { kind: 'response'; status: number; statusText: string; body: string }
    | { kind: 'error'; err: Error }
  > = [];

  const fakeFetch = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;

    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) {
          if (k !== undefined && v !== undefined) {
            headers[k] = v;
          }
        }
      } else {
        for (const [k, v] of Object.entries(h)) {
          if (v !== undefined) {
            headers[k] = v;
          }
        }
      }
    }

    calls.push({ url, method, headers, body, redirect: init?.redirect });

    const item = queue.shift();
    if (item === undefined) {
      throw new Error('FakeFetch: no response queued');
    }

    if (item.kind === 'error') {
      throw item.err;
    }

    return {
      ok: item.status >= 200 && item.status < 300,
      status: item.status,
      statusText: item.statusText,
      text: async () => item.body,
    };
  };

  return {
    fetch: fakeFetch,
    calls,
    enqueue(response) {
      queue.push({
        kind: 'response',
        status: response.status,
        statusText: response.statusText ?? 'OK',
        body: response.body ?? '',
      });
    },
    enqueueError(err: Error) {
      queue.push({ kind: 'error', err });
    },
  };
}
