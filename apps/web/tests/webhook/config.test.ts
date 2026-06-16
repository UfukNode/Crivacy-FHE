/**
 * Tests for webhook worker configuration.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  WebhookError,
  loadWebhookConfig,
  loadWebhookConfigFromEnv,
  resetWebhookConfigForTests,
} from '@/lib/webhook';

import { FIXTURE_ENCRYPTION_KEY_BASE64 } from './fixtures';

afterEach(() => {
  resetWebhookConfigForTests();
});

function buildValidEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AUTH_WEBHOOK_ENCRYPTION_KEY: FIXTURE_ENCRYPTION_KEY_BASE64,
    ...overrides,
  };
}

describe('loadWebhookConfigFromEnv', () => {
  it('loads defaults with minimal env', () => {
    const config = loadWebhookConfigFromEnv(buildValidEnv());
    expect(config.deliveryTimeoutMs).toBe(10_000);
    expect(config.concurrency).toBe(10);
    expect(config.circuitBreakerThreshold).toBe(50);
    expect(config.circuitBreakerWindowSeconds).toBe(3600);
    expect(config.responseBodyMaxBytes).toBe(1024);
    expect(config.pollIntervalSeconds).toBe(5);
    expect(config.retryScheduleSeconds).toEqual([10, 60, 300, 1800, 7200, 21600, 86400]);
    expect(config.encryptionKeyBase64).toBe(FIXTURE_ENCRYPTION_KEY_BASE64);
  });

  it('parses custom values from env', () => {
    const config = loadWebhookConfigFromEnv(
      buildValidEnv({
        WEBHOOK_DELIVERY_TIMEOUT_MS: '5000',
        WEBHOOK_CONCURRENCY: '20',
        WEBHOOK_CIRCUIT_BREAKER_THRESHOLD: '100',
        WEBHOOK_RESPONSE_BODY_MAX_BYTES: '2048',
        WEBHOOK_POLL_INTERVAL_SECONDS: '10',
      }),
    );
    expect(config.deliveryTimeoutMs).toBe(5000);
    expect(config.concurrency).toBe(20);
    expect(config.circuitBreakerThreshold).toBe(100);
    expect(config.responseBodyMaxBytes).toBe(2048);
    expect(config.pollIntervalSeconds).toBe(10);
  });

  it('parses custom retry schedule from JSON', () => {
    const config = loadWebhookConfigFromEnv(
      buildValidEnv({
        WEBHOOK_RETRY_SCHEDULE: '[5,30,120]',
      }),
    );
    expect(config.retryScheduleSeconds).toEqual([5, 30, 120]);
  });

  it('rejects missing encryption key', () => {
    expect(() => loadWebhookConfigFromEnv({})).toThrow(WebhookError);
  });

  it('rejects timeout below minimum', () => {
    expect(() =>
      loadWebhookConfigFromEnv(buildValidEnv({ WEBHOOK_DELIVERY_TIMEOUT_MS: '100' })),
    ).toThrow(WebhookError);
  });

  it('rejects timeout above maximum', () => {
    expect(() =>
      loadWebhookConfigFromEnv(buildValidEnv({ WEBHOOK_DELIVERY_TIMEOUT_MS: '60000' })),
    ).toThrow(WebhookError);
  });

  it('rejects concurrency of zero', () => {
    expect(() => loadWebhookConfigFromEnv(buildValidEnv({ WEBHOOK_CONCURRENCY: '0' }))).toThrow(
      WebhookError,
    );
  });

  it('rejects invalid retry schedule JSON', () => {
    expect(() =>
      loadWebhookConfigFromEnv(buildValidEnv({ WEBHOOK_RETRY_SCHEDULE: 'not-json' })),
    ).toThrow(WebhookError);
  });

  it('rejects empty retry schedule', () => {
    expect(() => loadWebhookConfigFromEnv(buildValidEnv({ WEBHOOK_RETRY_SCHEDULE: '[]' }))).toThrow(
      WebhookError,
    );
  });

  it('returns frozen config', () => {
    const config = loadWebhookConfigFromEnv(buildValidEnv());
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe('loadWebhookConfig', () => {
  it('parses raw config object', () => {
    const config = loadWebhookConfig({
      deliveryTimeoutMs: 8000,
      concurrency: 15,
      circuitBreakerThreshold: 30,
      circuitBreakerWindowSeconds: 1800,
      responseBodyMaxBytes: 512,
      encryptionKeyBase64: FIXTURE_ENCRYPTION_KEY_BASE64,
      pollIntervalSeconds: 3,
      retryScheduleSeconds: '[10,60]',
    });
    expect(config.deliveryTimeoutMs).toBe(8000);
    expect(config.concurrency).toBe(15);
    expect(config.retryScheduleSeconds).toEqual([10, 60]);
  });
});

describe('resetWebhookConfigForTests', () => {
  it('clears cached config', () => {
    const config1 = loadWebhookConfigFromEnv(buildValidEnv({ WEBHOOK_CONCURRENCY: '3' }));
    resetWebhookConfigForTests();
    const config2 = loadWebhookConfigFromEnv(buildValidEnv({ WEBHOOK_CONCURRENCY: '7' }));
    expect(config1.concurrency).toBe(3);
    expect(config2.concurrency).toBe(7);
  });
});
