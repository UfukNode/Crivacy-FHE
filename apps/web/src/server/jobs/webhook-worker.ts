/**
 * Webhook delivery worker — pg-boss job handler.
 *
 * Processes webhook deliveries by:
 * 1. Loading the delivery, endpoint, and event from the DB
 * 2. Decrypting the endpoint's signing secret
 * 3. Building and signing the outbound envelope
 * 4. HTTP POST to the firm's URL
 * 5. Updating delivery status (delivered / failed / dead_letter)
 * 6. Updating endpoint circuit breaker state
 * 7. Scheduling retries or dead-lettering
 *
 * @module
 */

import type PgBoss from 'pg-boss';

import { GCM_TAG_BYTES, loadKeyFromBase64, open } from '@/lib/auth/crypto-box';
import type { CrivacyDatabase } from '@/lib/db/client';
import {
  ensureWebhookUrlSafe,
  type WebhookUrlCheck,
} from '@/lib/security/webhook-url-guard';
import {
  type WebhookConfig,
  buildEnvelope,
  computeCircuitBreakerUpdate,
  computeNextRetryAt,
  executeDelivery,
  isMaxAttemptsReached,
  isTransientFailure,
  serializeEnvelope,
} from '@/lib/webhook';
import type { FetchLike } from '@/lib/webhook/delivery';

import { WEBHOOK_DELIVERY_QUEUE, type WebhookDeliveryJob, enqueueDelivery } from './queue';

/* ---------- Types ---------- */

/**
 * Dependencies injected into the worker — keeps it testable without
 * hitting the real DB.
 *
 * `urlGuard` lets tests swap out the SSRF re-validation for a stub that
 * always returns `ok`. Production leaves it unset and gets the real
 * `ensureWebhookUrlSafe`, which performs DNS + private-IP checks.
 */
export interface WorkerDeps {
  readonly db: CrivacyDatabase;
  readonly config: WebhookConfig;
  readonly fetchImpl?: FetchLike;
  readonly clock?: () => Date;
  readonly clockMs?: () => number;
  readonly urlGuard?: (rawUrl: string) => Promise<WebhookUrlCheck>;
}

/**
 * Minimal delivery row needed by the worker.
 */
export interface DeliveryRow {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly status: string;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/**
 * Minimal endpoint row needed by the worker.
 */
export interface EndpointRow {
  readonly id: string;
  readonly url: string;
  readonly signingSecretCiphertext: Uint8Array;
  readonly signingSecretNonce: Uint8Array;
  readonly signingKeyVersion: number;
  readonly consecutiveFailures: number;
  readonly circuitBreakerTrippedAt: Date | null;
  readonly disabledAt: Date | null;
}

/**
 * Minimal event row needed by the worker.
 */
export interface EventRow {
  readonly id: string;
  readonly firmId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly sourceSessionId: string | null;
  readonly createdAt: Date;
}

/**
 * Abstracts DB reads/writes so the worker stays testable.
 */
export interface WorkerRepository {
  findDeliveryById(db: CrivacyDatabase, id: string): Promise<DeliveryRow | null>;
  findEndpointByIdUnscoped(db: CrivacyDatabase, id: string): Promise<EndpointRow | null>;
  findEventById(db: CrivacyDatabase, id: string): Promise<EventRow | null>;
  markDelivering(db: CrivacyDatabase, id: string, now: Date): Promise<void>;
  markDelivered(
    db: CrivacyDatabase,
    id: string,
    httpStatus: number,
    responseBody: string,
    now: Date,
  ): Promise<void>;
  markFailed(
    db: CrivacyDatabase,
    id: string,
    attempts: number,
    httpStatus: number | null,
    error: string,
    responseBody: string | null,
    nextRetryAt: Date | null,
    now: Date,
  ): Promise<void>;
  markDeadLettered(
    db: CrivacyDatabase,
    id: string,
    attempts: number,
    httpStatus: number | null,
    error: string,
    responseBody: string | null,
    now: Date,
  ): Promise<void>;
  updateEndpointCircuitBreaker(
    db: CrivacyDatabase,
    endpointId: string,
    update: {
      consecutiveFailures: number;
      circuitBreakerTrippedAt: Date | null;
      lastSuccessAt?: Date;
      lastFailureAt?: Date;
    },
  ): Promise<void>;
}

/* ---------- Process single delivery ---------- */

/**
 * Process a single webhook delivery.
 *
 * This is the core logic extracted as a pure-ish async function with
 * injected dependencies. The pg-boss handler wraps this.
 */
export async function processDelivery(
  deps: WorkerDeps,
  repo: WorkerRepository,
  deliveryId: string,
  boss?: PgBoss,
): Promise<void> {
  const now = deps.clock?.() ?? new Date();

  // 1. Load delivery row
  const delivery = await repo.findDeliveryById(deps.db, deliveryId);
  if (delivery === null) return; // already deleted or doesn't exist

  // Skip if already in a terminal state
  if (delivery.status === 'delivered' || delivery.status === 'dead_letter') {
    return;
  }

  // 2. Load endpoint
  const endpoint = await repo.findEndpointByIdUnscoped(deps.db, delivery.endpointId);
  if (endpoint === null) return; // endpoint deleted

  // Skip if endpoint is disabled or circuit breaker is open
  if (endpoint.disabledAt !== null) return;
  if (endpoint.circuitBreakerTrippedAt !== null) return;

  // 3. Load event
  const event = await repo.findEventById(deps.db, delivery.eventId);
  if (event === null) return; // event deleted

  // 4. Mark as delivering
  await repo.markDelivering(deps.db, deliveryId, now);

  // 5. Decrypt signing secret
  //    The DB stores ciphertext with the 16-byte GCM auth tag appended.
  //    We need to split them before passing to `open()`.
  const encryptionKey = loadKeyFromBase64(deps.config.encryptionKeyBase64);
  const rawCiphertext = Buffer.from(
    endpoint.signingSecretCiphertext.buffer,
    endpoint.signingSecretCiphertext.byteOffset,
    endpoint.signingSecretCiphertext.byteLength,
  );
  const ciphertextOnly = rawCiphertext.subarray(0, rawCiphertext.length - GCM_TAG_BYTES);
  const tag = rawCiphertext.subarray(rawCiphertext.length - GCM_TAG_BYTES);
  const nonce = Buffer.from(
    endpoint.signingSecretNonce.buffer,
    endpoint.signingSecretNonce.byteOffset,
    endpoint.signingSecretNonce.byteLength,
  );
  const secretBuf = open(
    { ciphertext: ciphertextOnly, nonce, tag, keyVersion: endpoint.signingKeyVersion },
    encryptionKey,
  );
  const secret = secretBuf.toString('utf8');

  // 6. Build envelope — `firmId` intentionally not forwarded; the
  //    receiving firm knows its own identity from the signing
  //    secret, and multi-recipient fan-out means one event can
  //    legitimately reach multiple firms.
  const envelope = buildEnvelope({
    deliveryId: delivery.id,
    eventType: event.type,
    eventCreatedAt: event.createdAt,
    payload: event.payload as Record<string, unknown>,
    sourceSessionId: event.sourceSessionId,
  });
  const body = serializeEnvelope(envelope);

  // 7. SSRF re-validation (AUD-INT-AUTHZ-SSRF-001).
  //    `ensureWebhookUrlSafe` was already called when the endpoint was
  //    created / updated, but DNS rebinding defeats that: the domain
  //    can resolve to a public IP at create-time and a private IP at
  //    delivery-time. Re-validating here re-runs the full DNS + host
  //    + IP check against the URL we are about to hit. A blocked URL
  //    is permanent from our perspective (the firm's operator is
  //    responsible for the DNS record), so we dead-letter immediately
  //    instead of retrying — retrying a poisoned hostname just keeps
  //    trying to reach an internal IP. The circuit breaker is fed the
  //    same failure signal so repeated SSRF rejections trip the
  //    endpoint off.
  const urlGuard = deps.urlGuard ?? ensureWebhookUrlSafe;
  const urlCheck = await urlGuard(endpoint.url);
  if (!urlCheck.ok) {
    const ssrfError = `ssrf_blocked_at_delivery: ${urlCheck.reason}`;
    const newAttempts = delivery.attempts + 1;
    await repo.markDeadLettered(
      deps.db,
      deliveryId,
      newAttempts,
      null,
      ssrfError,
      null,
      now,
    );
    const cbUpdate = computeCircuitBreakerUpdate(
      {
        consecutiveFailures: endpoint.consecutiveFailures,
        circuitBreakerTrippedAt: endpoint.circuitBreakerTrippedAt,
      },
      false,
      deps.config.circuitBreakerThreshold,
      now,
    );
    await repo.updateEndpointCircuitBreaker(deps.db, endpoint.id, {
      consecutiveFailures: cbUpdate.consecutiveFailures,
      circuitBreakerTrippedAt: cbUpdate.circuitBreakerTrippedAt,
      ...(cbUpdate.lastFailureAt !== undefined ? { lastFailureAt: cbUpdate.lastFailureAt } : {}),
    });
    return;
  }

  // 8. Execute delivery
  const timestamp = Math.floor(now.getTime() / 1000);
  const result = await executeDelivery(
    {
      url: endpoint.url,
      body,
      secret,
      eventId: event.id,
      deliveryId: delivery.id,
      timestamp,
    },
    deps.config.deliveryTimeoutMs,
    deps.config.responseBodyMaxBytes,
    deps.fetchImpl,
    deps.clockMs,
  );

  const newAttempts = delivery.attempts + 1;

  // 9. Update delivery status
  if (result.success) {
    await repo.markDelivered(
      deps.db,
      deliveryId,
      result.httpStatus,
      result.responseBodySample,
      now,
    );

    // Reset circuit breaker on success
    const cbUpdate = computeCircuitBreakerUpdate(
      {
        consecutiveFailures: endpoint.consecutiveFailures,
        circuitBreakerTrippedAt: endpoint.circuitBreakerTrippedAt,
      },
      true,
      deps.config.circuitBreakerThreshold,
      now,
    );
    await repo.updateEndpointCircuitBreaker(deps.db, endpoint.id, {
      consecutiveFailures: cbUpdate.consecutiveFailures,
      circuitBreakerTrippedAt: cbUpdate.circuitBreakerTrippedAt,
      ...(cbUpdate.lastSuccessAt !== undefined ? { lastSuccessAt: cbUpdate.lastSuccessAt } : {}),
    });
  } else {
    // Failure path
    const shouldRetry =
      isTransientFailure(result) && !isMaxAttemptsReached(newAttempts, delivery.maxAttempts);

    if (shouldRetry) {
      const nextRetryAt = computeNextRetryAt(
        newAttempts - 1, // 0-indexed retry attempt
        deps.config.retryScheduleSeconds,
        now,
      );
      await repo.markFailed(
        deps.db,
        deliveryId,
        newAttempts,
        result.httpStatus,
        result.error,
        result.responseBodySample,
        nextRetryAt,
        now,
      );

      // Schedule retry via pg-boss
      if (boss !== undefined) {
        await enqueueDelivery(boss, deliveryId, nextRetryAt);
      }
    } else {
      // Dead letter — no more retries
      await repo.markDeadLettered(
        deps.db,
        deliveryId,
        newAttempts,
        result.httpStatus,
        result.error,
        result.responseBodySample,
        now,
      );
    }

    // Update circuit breaker on failure
    const cbUpdate = computeCircuitBreakerUpdate(
      {
        consecutiveFailures: endpoint.consecutiveFailures,
        circuitBreakerTrippedAt: endpoint.circuitBreakerTrippedAt,
      },
      false,
      deps.config.circuitBreakerThreshold,
      now,
    );
    await repo.updateEndpointCircuitBreaker(deps.db, endpoint.id, {
      consecutiveFailures: cbUpdate.consecutiveFailures,
      circuitBreakerTrippedAt: cbUpdate.circuitBreakerTrippedAt,
      ...(cbUpdate.lastFailureAt !== undefined ? { lastFailureAt: cbUpdate.lastFailureAt } : {}),
    });
  }
}

/* ---------- pg-boss registration ---------- */

/**
 * Register the webhook delivery worker with pg-boss.
 *
 * @param boss - pg-boss instance
 * @param deps - Worker dependencies
 * @param repo - Worker repository
 * @returns Cleanup function to unsubscribe
 */
export async function registerWebhookWorker(
  boss: PgBoss,
  deps: WorkerDeps,
  repo: WorkerRepository,
): Promise<string> {
  return boss.work<WebhookDeliveryJob>(
    WEBHOOK_DELIVERY_QUEUE,
    { batchSize: deps.config.concurrency },
    async (jobs) => {
      for (const job of jobs) {
        await processDelivery(deps, repo, job.data.deliveryId, boss);
      }
    },
  );
}
