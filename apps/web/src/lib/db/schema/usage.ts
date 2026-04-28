import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys';
import { firms } from './firms';

/**
 * `usage_events` — one row per billable API request. Highest-volume table
 * in the schema; partitioning by month is planned for step 26 (backups +
 * pruning) once real traffic numbers are known. For now the monthly
 * aggregate in `usage_aggregates` is what the dashboard reads; the events
 * table is kept for drill-down, audit, and invoicing.
 *
 * `bigserial` is intentional here — the per-request cost of generating a
 * v4 uuid is small but adds up at 100k+ requests/min, and we never expose
 * the id externally.
 *
 * `endpoint` stores the canonicalized route template (e.g.
 * `/api/v1/sessions/:id`) not the raw path, so cardinality stays bounded.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    method: varchar('method', { length: 8 }).notNull(),
    statusCode: smallint('status_code').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    requestId: uuid('request_id').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    errorCode: varchar('error_code', { length: 64 }),
    billable: integer('billable').notNull().default(1),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('usage_events_firm_ts_idx').on(table.firmId, table.ts),
    index('usage_events_api_key_ts_idx').on(table.apiKeyId, table.ts),
    index('usage_events_endpoint_ts_idx').on(table.endpoint, table.ts),
    index('usage_events_status_idx').on(table.statusCode),
    check(
      'usage_events_method_allowed',
      sql`${table.method} in ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS')`,
    ),
  ],
);

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;

/**
 * `usage_aggregates` — hourly rollup per (firm, endpoint, hour). Populated
 * by the pg-boss worker at PLAN.md step 11 (window = previous hour). The
 * dashboard and `/api/v1/usage` endpoint read from this table exclusively;
 * raw events are only touched for drill-down queries.
 *
 * Latency percentiles are pre-computed integers in milliseconds. The
 * worker uses `percentile_disc` on the source rows; approximation is fine
 * at the hourly granularity.
 */
export const usageAggregates = pgTable(
  'usage_aggregates',
  {
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    hour: timestamp('hour', { withTimezone: true, mode: 'date' }).notNull(),
    count: bigint('count', { mode: 'number' }).notNull(),
    billableCount: bigint('billable_count', { mode: 'number' }).notNull(),
    errors4xx: bigint('errors_4xx', { mode: 'number' })
      .notNull()
      .default(sql`0`),
    errors5xx: bigint('errors_5xx', { mode: 'number' })
      .notNull()
      .default(sql`0`),
    p50Ms: integer('p50_ms').notNull(),
    p95Ms: integer('p95_ms').notNull(),
    p99Ms: integer('p99_ms').notNull(),
    avgMs: integer('avg_ms').notNull(),
    maxMs: integer('max_ms').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'usage_aggregates_pk',
      columns: [table.firmId, table.endpoint, table.hour],
    }),
    index('usage_aggregates_firm_hour_idx').on(table.firmId, table.hour),
    index('usage_aggregates_hour_idx').on(table.hour),
  ],
);

export type UsageAggregate = typeof usageAggregates.$inferSelect;
export type NewUsageAggregate = typeof usageAggregates.$inferInsert;
