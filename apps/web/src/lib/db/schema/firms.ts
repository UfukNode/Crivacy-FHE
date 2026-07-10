import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { firmTierEnum } from './enums';

/**
 * `firms` — top-level tenant record. Every other row in the database that
 * belongs to a customer carries `firm_id` pointing here. Soft delete only
 * (`deleted_at`); a firm row is never physically removed so audit history
 * survives. Slug is the externally visible identifier used for dashboard
 * subdomains (`<slug>.dashboard.crivacy.io` — optional feature, slug is
 * unique regardless).
 */
export const firms = pgTable(
  'firms',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    tier: firmTierEnum('tier').notNull().default('free'),
    contactEmail: varchar('contact_email', { length: 320 }).notNull(),
    countryCode: varchar('country_code', { length: 2 }),
    billingEmail: varchar('billing_email', { length: 320 }),
    supportUrl: text('support_url'),
    notes: text('notes'),
    // On-chain EVM address the firm registered (wallet connect, SIWE-proven).
    // The gatekeeper `grantAccess(user, firm, minLevel)` targets THIS address
    // per user at consent time; the firm decrypts the `eligible` verdict with
    // the matching key (never held by Crivacy). Null until the firm connects a
    // wallet. Stored lowercase, EIP-55 not enforced at rest (checksum is a
    // display concern) — the CHECK constraint guarantees a 20-byte 0x hex.
    onchainAddress: varchar('onchain_address', { length: 42 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    // Partial unique index — only live firms enforce slug uniqueness.
    // Soft-deleted rows keep their slug on the record for history but
    // stop blocking reuse, so an admin who deactivates a firm can
    // later create a fresh one with the same slug. Restore paths
    // must guard against conflicts before clearing `deleted_at`.
    uniqueIndex('firms_slug_key').on(table.slug).where(sql`${table.deletedAt} IS NULL`),
    index('firms_tier_idx').on(table.tier),
    index('firms_deleted_at_idx').on(table.deletedAt),
  ],
);

export type Firm = typeof firms.$inferSelect;
export type NewFirm = typeof firms.$inferInsert;

/**
 * `firm_settings` — one row per firm, 1:1 with `firms`. Kept in a separate
 * table instead of denormalized columns because it collects a handful of
 * configuration knobs that evolve independently from the core firm record
 * (branding JSON, IP allowlist, security posture). Primary key is
 * `firm_id`; insert happens in the same transaction as firm creation.
 *
 * `default_webhook_secret_id` is intentionally NOT a foreign key to
 * `webhook_endpoints`. Adding an FK would create a circular dependency
 * (`webhook_endpoints.firm_id` → `firms.id`, `firm_settings.default_webhook_secret_id`
 * → `webhook_endpoints.id`) that complicates rollbacks. Integrity is
 * enforced in the repository layer.
 */
export const firmSettings = pgTable('firm_settings', {
  firmId: uuid('firm_id')
    .primaryKey()
    .references(() => firms.id, { onDelete: 'cascade' }),
  branding: jsonb('branding')
    .notNull()
    .default(sql`'{}'::jsonb`),
  ipAllowlist: text('ip_allowlist')
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  defaultWebhookSecretId: uuid('default_webhook_secret_id'),
  totpRequired: boolean('totp_required').notNull().default(true),
  mtlsRequired: boolean('mtls_required').notNull().default(false),
  dataRetentionDays: integer('data_retention_days').notNull().default(2555),
  contractConfigVersion: varchar('contract_config_version', { length: 32 }).notNull().default('v1'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type FirmSettings = typeof firmSettings.$inferSelect;
export type NewFirmSettings = typeof firmSettings.$inferInsert;
