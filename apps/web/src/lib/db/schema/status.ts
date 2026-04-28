import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
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

import {
  incidentSeverityEnum,
  incidentStatusEnum,
  statusComponentStateEnum,
  statusHistorySourceEnum,
} from './enums';
import { adminUsers } from './users';

/**
 * `status_components` — the public catalog of service components shown on
 * `/status`. `slug` is used in Alertmanager receivers so an alert for
 * `api-p99` maps to the component row without looking it up by name.
 *
 * `group_name` replaces `group` from PLAN.md §7 because `group` is a
 * reserved SQL keyword. Groups are a display-only concept; the dashboard
 * renders components with the same `group_name` under a collapsible
 * heading in `position` order.
 */
export const statusComponents = pgTable(
  'status_components',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    slug: varchar('slug', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description'),
    groupName: varchar('group_name', { length: 64 }),
    position: integer('position').notNull().default(0),
    currentState: statusComponentStateEnum('current_state').notNull().default('operational'),
    manualOverride: boolean('manual_override').notNull().default(false),
    manualOverrideReason: varchar('manual_override_reason', { length: 256 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('status_components_slug_key').on(table.slug),
    index('status_components_group_position_idx').on(table.groupName, table.position),
  ],
);

export type StatusComponent = typeof statusComponents.$inferSelect;
export type NewStatusComponent = typeof statusComponents.$inferInsert;

/**
 * `status_history` — append-only time series of component state changes.
 * Populated by the Alertmanager receiver (step 20) and by manual admin
 * overrides. The 90-day uptime bar on `/status` is computed from this
 * table via a window query; there is no denormalized uptime column.
 */
export const statusHistory = pgTable(
  'status_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => statusComponents.id, { onDelete: 'cascade' }),
    state: statusComponentStateEnum('state').notNull(),
    source: statusHistorySourceEnum('source').notNull(),
    alertName: varchar('alert_name', { length: 128 }),
    note: text('note'),
    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('status_history_component_ts_idx').on(table.componentId, table.ts),
    index('status_history_ts_idx').on(table.ts),
  ],
);

export type StatusHistoryEntry = typeof statusHistory.$inferSelect;
export type NewStatusHistoryEntry = typeof statusHistory.$inferInsert;

/**
 * `status_incidents` — operator-authored incidents surfaced on the
 * status page. `components` stores the UUIDs of affected components as a
 * plain `uuid[]` column; we deliberately avoid a join table because an
 * incident's affected components are read together with the incident
 * in every query path.
 *
 * Updates (post-mortem timeline entries) are stored inline in
 * `updates_timeline` as a JSONB array of `{at, status, body}` triples
 * that the dashboard appends to. Writing is done via atomic
 * `jsonb_insert` so concurrent updates do not overwrite.
 */
export const statusIncidents = pgTable(
  'status_incidents',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    title: varchar('title', { length: 256 }).notNull(),
    body: text('body').notNull(),
    severity: incidentSeverityEnum('severity').notNull(),
    status: incidentStatusEnum('status').notNull().default('investigating'),
    componentIds: uuid('component_ids')
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    updatesTimeline: jsonb('updates_timeline')
      .notNull()
      .default(sql`'[]'::jsonb`),
    published: boolean('published').notNull().default(true),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    identifiedAt: timestamp('identified_at', { withTimezone: true, mode: 'date' }),
    monitoringAt: timestamp('monitoring_at', { withTimezone: true, mode: 'date' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    createdBy: uuid('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('status_incidents_started_at_idx').on(table.startedAt),
    index('status_incidents_status_idx').on(table.status),
    index('status_incidents_severity_idx').on(table.severity),
  ],
);

export type StatusIncident = typeof statusIncidents.$inferSelect;
export type NewStatusIncident = typeof statusIncidents.$inferInsert;

/**
 * `status_subscribers` — email subscribers to incident notifications.
 * `confirmed_at` is NULL until the double opt-in link is clicked;
 * `unsubscribe_token` is embedded in every outbound email and, when
 * opened, soft-disables the row via `unsubscribed_at`.
 *
 * `component_ids` is an empty array when the subscriber wants everything;
 * otherwise it is an allowlist.
 */
export const statusSubscribers = pgTable(
  'status_subscribers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: varchar('email', { length: 320 }).notNull(),
    componentIds: uuid('component_ids')
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    confirmToken: uuid('confirm_token')
      .notNull()
      .default(sql`gen_random_uuid()`),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    unsubscribeToken: uuid('unsubscribe_token')
      .notNull()
      .default(sql`gen_random_uuid()`),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true, mode: 'date' }),
    failedDeliveries: smallint('failed_deliveries').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('status_subscribers_email_key').on(sql`lower(${table.email})`),
    index('status_subscribers_confirmed_idx').on(table.confirmedAt),
  ],
);

export type StatusSubscriber = typeof statusSubscribers.$inferSelect;
export type NewStatusSubscriber = typeof statusSubscribers.$inferInsert;
