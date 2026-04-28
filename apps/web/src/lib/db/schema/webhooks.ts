import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { webhookDeliveryStatusEnum } from './enums';
import { firms } from './firms';
import { kycCredentialsMeta, kycSessions } from './kyc';

/**
 * Raw-binary alias for webhook signing secrets (AES-256-GCM ciphertext).
 * Duplicated from `kyc.ts` so this file stays self-contained; both use
 * the same custom wire-conversion so a top-level helper would not reduce
 * code.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  },
});

/**
 * `webhook_endpoints` — outbound webhook subscriptions configured by a
 * firm. The signing secret is stored as AES-256-GCM ciphertext; the raw
 * value is returned exactly once, at creation time, then discarded. The
 * delivery worker (PLAN.md step 11) decrypts in-memory to sign each
 * outgoing HMAC header.
 *
 * Circuit breaker: after `circuit_breaker_tripped_at` is set by the
 * worker, delivery pauses until the dashboard operator clears the flag.
 * `consecutive_failures` is the monotonic counter that drives the break.
 *
 * `events` is a text array of `WebhookEventType` values (dot-separated,
 * which Postgres enums cannot represent).
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 256 }).notNull(),
    url: text('url').notNull(),
    events: text('events')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    signingSecretCiphertext: bytea('signing_secret_ciphertext').notNull(),
    signingSecretNonce: bytea('signing_secret_nonce').notNull(),
    signingKeyVersion: integer('signing_key_version').notNull(),
    signingSecretRotatedAt: timestamp('signing_secret_rotated_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true, mode: 'date' }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    circuitBreakerTrippedAt: timestamp('circuit_breaker_tripped_at', {
      withTimezone: true,
      mode: 'date',
    }),
    disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'date' }),
    disabledReason: varchar('disabled_reason', { length: 256 }),
    maxAttempts: smallint('max_attempts').notNull().default(7),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('webhook_endpoints_firm_id_idx').on(table.firmId),
    index('webhook_endpoints_disabled_at_idx').on(table.disabledAt),
    index('webhook_endpoints_circuit_breaker_idx').on(table.circuitBreakerTrippedAt),
    // Mirror the Zod `HttpsUrl` 2048-char cap at the database level so
    // a direct-SQL insert or schema-bypassing client can't exceed it.
    check('webhook_endpoints_url_length_chk', sql`char_length(${table.url}) <= 2048`),
  ],
);

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;

/**
 * `webhook_events` — materialized list of domain events that at least one
 * endpoint has subscribed to. Writing happens at the boundary where a
 * state change is persisted (credential create, KYC session completion,
 * revocation, etc.). A single event row fans out to multiple deliveries.
 *
 * `idempotency_key` is optional; when present it is scoped to
 * `(firm_id, type)` so a producer can safely retry without creating
 * duplicate events. The partial unique index enforces this only when the
 * key is supplied.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 64 }).notNull(),
    sourceSessionId: uuid('source_session_id').references(() => kycSessions.id, {
      onDelete: 'set null',
    }),
    sourceCredentialId: uuid('source_credential_id').references(() => kycCredentialsMeta.id, {
      onDelete: 'set null',
    }),
    payload: jsonb('payload').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('webhook_events_idempotency_key')
      .on(table.firmId, table.type, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('webhook_events_firm_type_idx').on(table.firmId, table.type, table.createdAt),
  ],
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;

/**
 * `webhook_deliveries` — one row per (endpoint, event) attempt. Lives in
 * its own table rather than as a column on `webhook_events` because a
 * single event fans out to every endpoint that subscribes to its type,
 * and each delivery follows its own retry timeline.
 *
 * The retry schedule follows PLAN.md §10: 10s → 1m → 5m → 30m → 2h → 6h
 * → 24h, after which the row is stamped `dead_letter` and surfaced in
 * the dashboard. `response_body_sample` stores the first 1 KB of the
 * most recent failing response for operator debugging; the payload
 * itself lives on the parent event row.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => webhookEvents.id, { onDelete: 'cascade' }),
    /**
     * Denormalized copy of `webhook_endpoints.firm_id`. Cat 34b
     * Faz 12 added this column so RLS policies can gate the table
     * with a direct equality comparison instead of a nested subquery
     * across `webhook_endpoints`. The value is set at INSERT time
     * by `createDelivery` from the endpoint's firm; it never
     * diverges because endpoints don't migrate between firms.
     */
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    status: webhookDeliveryStatusEnum('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(7),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true, mode: 'date' }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
    lastHttpStatus: smallint('last_http_status'),
    lastError: text('last_error'),
    responseBodySample: text('response_body_sample'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_endpoint_event_key').on(table.endpointId, table.eventId),
    index('webhook_deliveries_status_retry_idx').on(table.status, table.nextRetryAt),
    index('webhook_deliveries_endpoint_status_idx').on(table.endpointId, table.status),
  ],
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
