/**
 * Security event outbox dispatcher — the consumer side of the bus.
 *
 * {@link dispatchPendingSecurityEvents} polls the outbox for rows
 * where `processed_at IS NULL`, hands each row to every registered
 * subscriber in parallel, and either marks the row processed (all
 * subscribers accepted) or bumps `attempts` + `last_error` (at least
 * one subscriber threw).
 *
 * Ordering guarantee — per-subject, yes (emitted_at is monotonic for
 * a single row's writes); globally, no (two subjects can interleave).
 * Subscribers MUST be idempotent on `eventId` so a retry doesn't
 * double-dispatch.
 *
 * Error handling — a subscriber that throws does NOT block other
 * subscribers for the same event. We collect all failures, log them,
 * bump `attempts`, and try again on the next poll. After MAX_ATTEMPTS
 * the row is parked (attempts keeps growing but the row lives on so
 * operators can inspect it); a cleanup sweeper archives parked rows.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';

import type { EventSubjectKind, SecurityEventType } from './emit';

/* -------------------------------------------------------------------------- */
/*  Subscriber contract                                                        */
/* -------------------------------------------------------------------------- */

export interface SecurityEventEnvelope {
  readonly id: string;
  readonly eventType: SecurityEventType;
  readonly eventVersion: number;
  readonly subject: { readonly kind: EventSubjectKind; readonly id: string };
  readonly payload: Readonly<Record<string, unknown>>;
  readonly emittedAt: Date;
}

/**
 * Context the dispatcher threads through to every subscriber. Keeps
 * the subscriber signature stable as we grow the set of resources
 * subscribers need (currently just the DB, tomorrow maybe a tracer
 * or feature-flag client).
 */
export interface SubscriberContext {
  readonly db: CrivacyDatabase;
}

/**
 * Subscriber handler — receives every event the dispatcher pulls off
 * the outbox. Implementations are expected to:
 *   - Be idempotent on `event.id` (a retry must not double-process).
 *   - Return `void` on success; throw on any failure that should
 *     trigger a retry.
 *   - Not hold references to `event` or `ctx` beyond the function's
 *     lifetime.
 */
export type SecurityEventSubscriber = (
  event: SecurityEventEnvelope,
  ctx: SubscriberContext,
) => Promise<void>;

const subscribers: SecurityEventSubscriber[] = [];

/**
 * Register a subscriber. Subscribers are called in registration order
 * but concurrently via `Promise.all` — order does not imply sequential
 * guarantees. Call this once at module load (or wherever the app's
 * bootstrap wires up long-lived singletons).
 */
export function registerSecurityEventSubscriber(
  subscriber: SecurityEventSubscriber,
): void {
  subscribers.push(subscriber);
}

/**
 * Test-only — clear the registry. Never call this from app code.
 */
export function __resetSecurityEventSubscribersForTest(): void {
  subscribers.length = 0;
}

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

/** Max attempts before the row is treated as parked. */
export const MAX_DISPATCH_ATTEMPTS = 10;

/** Default poll batch size. */
const DEFAULT_BATCH_SIZE = 50;

export interface DispatchInput {
  readonly db: CrivacyDatabase;
  readonly now: Date;
  /** Max rows to process in one sweep. Default 50. */
  readonly batchSize?: number;
}

export interface DispatchResult {
  readonly picked: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly parked: number;
}

interface PendingRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_type: string;
  readonly event_version: number;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly payload: Record<string, unknown>;
  readonly emitted_at: string;
  readonly attempts: number;
}

/**
 * Pull a batch of pending events, dispatch each to every subscriber,
 * and mark rows processed or bump retry counters.
 *
 * Safe to run concurrently against itself — the UPDATE inside
 * {@link markProcessed} + {@link markFailed} is atomic, and worker
 * processes coordinate via `processed_at IS NULL` + `attempts < cap`
 * so two workers that race pick different rows when we add the
 * `FOR UPDATE SKIP LOCKED` clause (Postgres 9.5+). The SELECT below
 * uses that clause so a deployment can horizontally scale workers
 * without additional leasing infrastructure.
 */
export async function dispatchPendingSecurityEvents(
  input: DispatchInput,
): Promise<DispatchResult> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const batch = await input.db.execute<PendingRow>(
    sql`SELECT id, event_type, event_version, subject_kind, subject_id,
               payload, emitted_at::text, attempts
          FROM security_events_outbox
         WHERE processed_at IS NULL
           AND attempts < ${MAX_DISPATCH_ATTEMPTS}
         ORDER BY emitted_at ASC
         LIMIT ${batchSize}
         FOR UPDATE SKIP LOCKED`,
  );

  const rows = batch.rows as unknown as PendingRow[];

  let succeeded = 0;
  let failed = 0;
  let parked = 0;

  for (const row of rows) {
    const envelope: SecurityEventEnvelope = {
      id: row.id,
      eventType: row.event_type as SecurityEventType,
      eventVersion: row.event_version,
      subject: {
        kind: row.subject_kind as EventSubjectKind,
        id: row.subject_id,
      },
      payload: row.payload,
      emittedAt: new Date(row.emitted_at),
    };

    const subscriberCtx: SubscriberContext = { db: input.db };
    const errors: string[] = [];
    await Promise.all(
      subscribers.map(async (subscriber) => {
        try {
          await subscriber(envelope, subscriberCtx);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }),
    );

    if (errors.length === 0) {
      await markProcessed(input.db, row.id, input.now);
      succeeded++;
    } else {
      const nextAttempts = row.attempts + 1;
      await markFailed(input.db, row.id, nextAttempts, errors.join(' | '));
      failed++;
      if (nextAttempts >= MAX_DISPATCH_ATTEMPTS) parked++;
    }
  }

  return { picked: rows.length, succeeded, failed, parked };
}

async function markProcessed(
  db: CrivacyDatabase,
  id: string,
  now: Date,
): Promise<void> {
  await db.execute(
    sql`UPDATE security_events_outbox
          SET processed_at = ${now.toISOString()},
              last_error = NULL
        WHERE id = ${id}`,
  );
}

async function markFailed(
  db: CrivacyDatabase,
  id: string,
  nextAttempts: number,
  lastError: string,
): Promise<void> {
  // Truncate the error string so a subscriber that emits giant stack
  // traces cannot bloat this row indefinitely.
  const truncated = lastError.slice(0, 2048);
  await db.execute(
    sql`UPDATE security_events_outbox
          SET attempts = ${nextAttempts},
              last_error = ${truncated}
        WHERE id = ${id}`,
  );
}
