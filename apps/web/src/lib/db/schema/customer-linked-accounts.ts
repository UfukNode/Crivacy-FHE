import { sql } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { customers } from './customers';

// ---------------------------------------------------------------------------
// customer_linked_accounts
// ---------------------------------------------------------------------------

/**
 * `customer_linked_accounts` — OAuth / wallet links for social sign-in.
 *
 * A customer may have zero or more linked external accounts (Google,
 * chain Console, Loop Wallet). Each row stores the provider name and
 * the provider-assigned unique account identifier so the platform can
 * map an OAuth callback → existing customer without password.
 *
 * The unique constraint on `(provider, provider_account_id)` prevents
 * two customers from linking the same external account. The unique
 * constraint on `(customer_id, provider)` limits one link per provider
 * per customer (you can't link two Google accounts).
 *
 * On customer hard-delete (cascade) all links are removed.
 */
export const customerLinkedAccounts = pgTable(
  'customer_linked_accounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** Provider name: 'google', 'wallet', 'loop_wallet'. */
    provider: varchar('provider', { length: 32 }).notNull(),
    /** Unique identifier from the provider (e.g. Google sub, wallet address). */
    providerAccountId: text('provider_account_id').notNull(),
    /** Provider email (for display purposes only — not used for lookup). */
    providerEmail: varchar('provider_email', { length: 320 }),
    /** Display name from the provider profile (optional). */
    providerDisplayName: varchar('provider_display_name', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('customer_linked_accounts_provider_account_key').on(
      table.provider,
      table.providerAccountId,
    ),
    uniqueIndex('customer_linked_accounts_customer_provider_key').on(
      table.customerId,
      table.provider,
    ),
    index('customer_linked_accounts_customer_id_idx').on(table.customerId),
  ],
);

export type CustomerLinkedAccount = typeof customerLinkedAccounts.$inferSelect;
export type NewCustomerLinkedAccount = typeof customerLinkedAccounts.$inferInsert;
