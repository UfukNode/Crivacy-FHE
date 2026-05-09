/**
 * Webhook worker configuration — env-parsed, frozen singleton.
 *
 * Same pattern as `getFheConfig`, `getDiditConfig`, etc.
 *
 * @module
 */

import { z } from 'zod';

import { WebhookError } from './errors';
import { DEFAULT_RETRY_DELAYS_SECONDS } from './retry';

/* ---------- Schema ---------- */

const webhookConfigSchema = z.object({
  deliveryTimeoutMs: z.coerce.number().int().min(1000).max(30_000).default(10_000),

  retryScheduleSeconds: z
    .string()
    .default(JSON.stringify([...DEFAULT_RETRY_DELAYS_SECONDS]))
    .transform((s) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return null;
      }
    })
    .pipe(z.array(z.number().int().min(0)).min(1).max(20)),

  concurrency: z.coerce.number().int().min(1).max(100).default(10),

  circuitBreakerThreshold: z.coerce.number().int().min(1).default(50),

  circuitBreakerWindowSeconds: z.coerce.number().int().min(60).default(3600),

  responseBodyMaxBytes: z.coerce.number().int().min(0).max(10_240).default(1024),

  encryptionKeyBase64: z.string().min(1),

  pollIntervalSeconds: z.coerce.number().int().min(1).max(300).default(5),
});

/* ---------- Public types ---------- */

export interface WebhookConfig {
  readonly deliveryTimeoutMs: number;
  readonly retryScheduleSeconds: readonly number[];
  readonly concurrency: number;
  readonly circuitBreakerThreshold: number;
  readonly circuitBreakerWindowSeconds: number;
  readonly responseBodyMaxBytes: number;
  readonly encryptionKeyBase64: string;
  readonly pollIntervalSeconds: number;
}

/* ---------- Singleton ---------- */

let cached: WebhookConfig | null = null;

export function getWebhookConfig(): WebhookConfig {
  if (cached !== null) return cached;
  return loadWebhookConfigFromEnv(process.env as Record<string, string | undefined>);
}

export function loadWebhookConfigFromEnv(env: Record<string, string | undefined>): WebhookConfig {
  const result = webhookConfigSchema.safeParse({
    deliveryTimeoutMs: env['WEBHOOK_DELIVERY_TIMEOUT_MS'],
    retryScheduleSeconds: env['WEBHOOK_RETRY_SCHEDULE'],
    concurrency: env['WEBHOOK_CONCURRENCY'],
    circuitBreakerThreshold: env['WEBHOOK_CIRCUIT_BREAKER_THRESHOLD'],
    circuitBreakerWindowSeconds: env['WEBHOOK_CIRCUIT_BREAKER_WINDOW_SECONDS'],
    responseBodyMaxBytes: env['WEBHOOK_RESPONSE_BODY_MAX_BYTES'],
    encryptionKeyBase64: env['AUTH_WEBHOOK_ENCRYPTION_KEY'],
    pollIntervalSeconds: env['WEBHOOK_POLL_INTERVAL_SECONDS'],
  });

  if (!result.success) {
    throw new WebhookError('invalid_config', `Invalid webhook config: ${result.error.message}`, {
      context: { issues: result.error.issues },
    });
  }

  const config: WebhookConfig = Object.freeze({
    deliveryTimeoutMs: result.data.deliveryTimeoutMs,
    retryScheduleSeconds: Object.freeze([...result.data.retryScheduleSeconds]),
    concurrency: result.data.concurrency,
    circuitBreakerThreshold: result.data.circuitBreakerThreshold,
    circuitBreakerWindowSeconds: result.data.circuitBreakerWindowSeconds,
    responseBodyMaxBytes: result.data.responseBodyMaxBytes,
    encryptionKeyBase64: result.data.encryptionKeyBase64,
    pollIntervalSeconds: result.data.pollIntervalSeconds,
  });

  cached = config;
  return config;
}

export function loadWebhookConfig(raw: Record<string, unknown>): WebhookConfig {
  const result = webhookConfigSchema.safeParse(raw);

  if (!result.success) {
    throw new WebhookError('invalid_config', `Invalid webhook config: ${result.error.message}`, {
      context: { issues: result.error.issues },
    });
  }

  const config: WebhookConfig = Object.freeze({
    deliveryTimeoutMs: result.data.deliveryTimeoutMs,
    retryScheduleSeconds: Object.freeze([...result.data.retryScheduleSeconds]),
    concurrency: result.data.concurrency,
    circuitBreakerThreshold: result.data.circuitBreakerThreshold,
    circuitBreakerWindowSeconds: result.data.circuitBreakerWindowSeconds,
    responseBodyMaxBytes: result.data.responseBodyMaxBytes,
    encryptionKeyBase64: result.data.encryptionKeyBase64,
    pollIntervalSeconds: result.data.pollIntervalSeconds,
  });

  cached = config;
  return config;
}

export function resetWebhookConfigForTests(): void {
  cached = null;
}
