import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { customers } from './customers';
import { firms } from './firms';

/**
 * `firm_credential_grants` — per-(firm, user) FHE access-grant handoff.
 *
 * When a user consents to a firm that has registered an on-chain address, the
 * consent handler upserts a `pending` row here in the request path (no chain
 * call). A cron-poll worker drains `pending`/`failed` rows and calls the
 * on-chain gatekeeper `grantAccess(userAddress, firmAddress, minLevel)` on
 * CrivacyKYC — the ~15s tx never blocks the consent redirect, and a crash just
 * re-drains from the durable row.
 *
 * On-chain `_grant[user][firm]` is the source of truth; this table is Crivacy's
 * durable intent + status ledger (idempotency, retry, audit). One row per
 * (firm, customer); re-consent updates `minLevel` and resets `status` to
 * `pending` so a level upgrade re-grants.
 */
export const firmCredentialGrants = pgTable(
  'firm_credential_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** The user's on-chain wallet the credential is keyed to. */
    userAddress: varchar('user_address', { length: 42 }).notNull(),
    /** Snapshot of `firms.onchain_address` at enqueue time. */
    firmAddress: varchar('firm_address', { length: 42 }).notNull(),
    /** Minimum credential level the firm's consented scopes demand. */
    minLevel: varchar('min_level', { length: 16 }).notNull(),
    /** `pending` → worker un-drained; `granted` → tx landed; `failed` → retry cap. */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    txHash: varchar('tx_hash', { length: 66 }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('firm_credential_grants_firm_customer_key').on(table.firmId, table.customerId),
    index('firm_credential_grants_status_idx').on(table.status, table.createdAt),
  ],
);

export type FirmCredentialGrant = typeof firmCredentialGrants.$inferSelect;
export type NewFirmCredentialGrant = typeof firmCredentialGrants.$inferInsert;

/** Grant lifecycle status. */
export type FirmCredentialGrantStatus = 'pending' | 'granted' | 'failed';
