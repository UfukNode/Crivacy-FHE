import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * `idempotency_keys` — cached canonical responses for state-changing
 * endpoints that opt into the Stripe-style `Idempotency-Key` header.
 *
 * See `lib/http/idempotency.ts` for the middleware that consumes this
 * table. The shape is intentionally audience-agnostic; `subject_kind`
 * plus `subject_id` scope a key to the caller so two audiences with
 * the same key string never collide.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    subjectKind: varchar('subject_kind', { length: 16 }).notNull(),
    subjectId: varchar('subject_id', { length: 64 }).notNull(),
    endpoint: varchar('endpoint', { length: 128 }).notNull(),
    keyHash: text('key_hash').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: text('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('idempotency_keys_subject_endpoint_key_uk').on(
      table.subjectKind,
      table.subjectId,
      table.endpoint,
      table.keyHash,
    ),
    index('idempotency_keys_expires_at_idx').on(table.expiresAt),
  ],
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
