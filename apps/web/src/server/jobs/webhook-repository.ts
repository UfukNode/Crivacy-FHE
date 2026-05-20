/**
 * Webhook worker repository — DB operations for the delivery worker.
 *
 * These functions are distinct from the API-facing webhook repository
 * (`src/server/repositories/webhooks.ts`) because the worker needs
 * unscoped reads (no firm_id filter) and status transition updates
 * that the API layer never performs.
 *
 * @module
 */

import { eq, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { webhookDeliveries, webhookEndpoints, webhookEvents } from '@/lib/db/schema';

import type { DeliveryRow, EndpointRow, EventRow, WorkerRepository } from './webhook-worker';

/* ---------- Reads ---------- */

export async function findDeliveryById(
  db: CrivacyDatabase,
  id: string,
): Promise<DeliveryRow | null> {
  const rows = await db
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      eventId: webhookDeliveries.eventId,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      maxAttempts: webhookDeliveries.maxAttempts,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export async function findEndpointByIdUnscoped(
  db: CrivacyDatabase,
  id: string,
): Promise<EndpointRow | null> {
  const rows = await db
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      signingSecretCiphertext: webhookEndpoints.signingSecretCiphertext,
      signingSecretNonce: webhookEndpoints.signingSecretNonce,
      signingKeyVersion: webhookEndpoints.signingKeyVersion,
      consecutiveFailures: webhookEndpoints.consecutiveFailures,
      circuitBreakerTrippedAt: webhookEndpoints.circuitBreakerTrippedAt,
      disabledAt: webhookEndpoints.disabledAt,
    })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export async function findEventById(db: CrivacyDatabase, id: string): Promise<EventRow | null> {
  const rows = await db
    .select({
      id: webhookEvents.id,
      firmId: webhookEvents.firmId,
      type: webhookEvents.type,
      payload: webhookEvents.payload,
      sourceSessionId: webhookEvents.sourceSessionId,
      createdAt: webhookEvents.createdAt,
    })
    .from(webhookEvents)
    .where(eq(webhookEvents.id, id))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return {
    ...row,
    payload: row.payload as Record<string, unknown>,
    sourceSessionId: row.sourceSessionId ?? null,
  };
}

/* ---------- Status transitions ---------- */

export async function markDelivering(db: CrivacyDatabase, id: string, now: Date): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: 'delivering',
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, id));
}

export async function markDelivered(
  db: CrivacyDatabase,
  id: string,
  httpStatus: number,
  responseBody: string,
  now: Date,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: 'delivered',
      attempts: sql`${webhookDeliveries.attempts} + 1`,
      lastAttemptAt: now,
      lastHttpStatus: httpStatus,
      responseBodySample: responseBody,
      deliveredAt: now,
      nextRetryAt: null,
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, id));
}

export async function markFailed(
  db: CrivacyDatabase,
  id: string,
  attempts: number,
  httpStatus: number | null,
  error: string,
  responseBody: string | null,
  nextRetryAt: Date | null,
  now: Date,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: 'failed',
      attempts,
      lastAttemptAt: now,
      ...(httpStatus !== null ? { lastHttpStatus: httpStatus } : {}),
      lastError: error,
      ...(responseBody !== null ? { responseBodySample: responseBody } : {}),
      ...(nextRetryAt !== null ? { nextRetryAt } : {}),
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, id));
}

export async function markDeadLettered(
  db: CrivacyDatabase,
  id: string,
  attempts: number,
  httpStatus: number | null,
  error: string,
  responseBody: string | null,
  now: Date,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: 'dead_letter',
      attempts,
      lastAttemptAt: now,
      ...(httpStatus !== null ? { lastHttpStatus: httpStatus } : {}),
      lastError: error,
      ...(responseBody !== null ? { responseBodySample: responseBody } : {}),
      nextRetryAt: null,
      deadLetteredAt: now,
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, id));
}

/* ---------- Endpoint circuit breaker ---------- */

export async function updateEndpointCircuitBreaker(
  db: CrivacyDatabase,
  endpointId: string,
  update: {
    consecutiveFailures: number;
    circuitBreakerTrippedAt: Date | null;
    lastSuccessAt?: Date;
    lastFailureAt?: Date;
  },
): Promise<void> {
  await db
    .update(webhookEndpoints)
    .set({
      consecutiveFailures: update.consecutiveFailures,
      circuitBreakerTrippedAt: update.circuitBreakerTrippedAt,
      ...(update.lastSuccessAt !== undefined ? { lastSuccessAt: update.lastSuccessAt } : {}),
      ...(update.lastFailureAt !== undefined ? { lastFailureAt: update.lastFailureAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(webhookEndpoints.id, endpointId));
}

/* ---------- Assembled WorkerRepository ---------- */

/**
 * Build the standard worker repository from the functions above.
 */
export function buildWorkerRepository(): WorkerRepository {
  return {
    findDeliveryById,
    findEndpointByIdUnscoped,
    findEventById,
    markDelivering,
    markDelivered,
    markFailed,
    markDeadLettered,
    updateEndpointCircuitBreaker,
  };
}
