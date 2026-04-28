import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { auditActorKindEnum, auditTargetKindEnum } from './enums';
import { firms } from './firms';

/**
 * `audit_log` — append-only record of every privileged action in the
 * system. The writer API (PLAN.md step 7) rejects updates and deletes;
 * the only legal mutation after INSERT is none. GDPR/KVKK erasure
 * (PLAN.md step 30) redacts the `meta` payload but never removes the row.
 *
 * `actor_id` is nullable because:
 *   * `system` actors (scheduled workers, chain block advancement) have
 *     no backing user.
 *   * Failed authentication attempts write a row before any user is
 *     identified.
 *
 * `target_kind` and `target_id` are also nullable because some events
 * describe a broad action (e.g. `system.backup.started`) that has no
 * single subject.
 *
 * A `bigserial` primary key is used deliberately: audit is high-volume,
 * we never leak it externally, and it gives us a monotonic insertion
 * order for tamper-evident export (step 30 compliance stream).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorKind: auditActorKindEnum('actor_kind').notNull(),
    actorId: uuid('actor_id'),
    actorLabel: varchar('actor_label', { length: 320 }),
    firmId: uuid('firm_id').references(() => firms.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 128 }).notNull(),
    targetKind: auditTargetKindEnum('target_kind'),
    targetId: uuid('target_id'),
    targetRef: varchar('target_ref', { length: 256 }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: uuid('request_id'),
    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /**
     * Outbox event id — populated when this row was written by the
     * security-events subscriber. The partial unique index below
     * dedupes retries from the worker so at-least-once delivery does
     * not produce duplicate audit rows. Null for inline writers.
     */
    eventId: uuid('event_id'),
  },
  (table) => [
    index('audit_log_firm_ts_idx').on(table.firmId, table.ts),
    index('audit_log_actor_idx').on(table.actorKind, table.actorId, table.ts),
    index('audit_log_action_ts_idx').on(table.action, table.ts),
    index('audit_log_target_idx').on(table.targetKind, table.targetId),
    index('audit_log_ts_idx').on(table.ts),
    uniqueIndex('audit_log_event_id_unique')
      .on(table.eventId)
      .where(sql`${table.eventId} IS NOT NULL`),
  ],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
