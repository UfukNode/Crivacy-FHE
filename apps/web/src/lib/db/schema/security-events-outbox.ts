import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * `security_events_outbox` — the transactional outbox table that
 * {@link emitSecurityEvent} writes to. A background worker
 * (`lib/security-events/dispatcher.ts`) consumes pending rows and
 * fans them out to subscribers: audit writer, transactional email,
 * webhook fan-out, SIEM exporter.
 *
 * Motivation — previously every security-relevant state change fired
 * audit + email inline, AFTER the state change committed. A thrown
 * error in the post-commit dispatch left a silent gap in the trail.
 * The outbox collapses that window: the emit happens inside the same
 * transaction as the state change, so either both land or both roll
 * back.
 *
 * Consumers are required to be idempotent on `event_id` — a retry
 * from the worker must not produce a duplicate side effect.
 */
export const securityEventsOutbox = pgTable(
  'security_events_outbox',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    eventType: varchar('event_type', { length: 128 }).notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    subjectKind: varchar('subject_kind', { length: 16 }).notNull(),
    subjectId: varchar('subject_id', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    emittedAt: timestamp('emitted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    index('security_events_outbox_pending_idx').on(table.emittedAt),
    index('security_events_outbox_subject_idx').on(
      table.subjectKind,
      table.subjectId,
      table.emittedAt,
    ),
  ],
);

export type SecurityEventRow = typeof securityEventsOutbox.$inferSelect;
export type NewSecurityEventRow = typeof securityEventsOutbox.$inferInsert;
