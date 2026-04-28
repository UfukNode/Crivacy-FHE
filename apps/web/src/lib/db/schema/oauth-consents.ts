import { sql } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { customers } from './customers';
import { oauthClients } from './oauth-clients';

/**
 * `oauth_consents` — persistent record of a user's explicit approval
 * to share a specific scope set with a specific client.
 *
 * Consent is cached so the "bu firmayı zaten onaylamıştım" path skips
 * the consent screen entirely (Google/Plaid pattern). Fast path:
 *
 *   1. User returns to the firm.
 *   2. `/authorize` looks up `(user_id, client_id)` → active consent.
 *   3. If the current request's scope is a subset of the cached
 *      scope AND the row isn't past `expires_at` or revoked, we
 *      short-circuit to issuing a code.
 *
 * The scope is stored both as the canonical string (`scope`) and as
 * a SHA-256 hash (`scope_hash`) so lookups stay fast and correct
 * even with the same set in different orders.
 *
 *   - `expires_at = granted_at + client.consent_ttl_days`. Default 90
 *     days. Firm may shorten (higher-risk flows) but cannot extend.
 *   - `revoked_at` is stamped when the user hits "revoke" on the
 *     Connected Apps page. All tokens tied to this consent are
 *     invalidated in the same transaction.
 *   - Re-granting a revoked / expired consent inserts a NEW row. We
 *     keep history so the audit log can answer "did this user ever
 *     approve Firm X?"
 */
export const oauthConsents = pgTable(
  'oauth_consents',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: uuid('user_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    clientId: uuid('oauth_client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    /** Canonical space-separated scope (sorted, deduped). */
    scope: text('scope').notNull(),
    /**
     * SHA-256 of the canonical scope string. Lets the consent cache
     * key include scope without string comparison drift, and lets
     * audit rows reference consent by hash instead of full text.
     */
    scopeHash: text('scope_hash').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: text('revoked_reason'),
    /** Incremented every time this consent's cached fast path fires. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    // One active consent per (user, client, scope_hash) at a time;
    // revoked rows stay for history but don't block new grants.
    uniqueIndex('oauth_consents_active_idx')
      .on(table.userId, table.clientId, table.scopeHash)
      .where(sql`revoked_at IS NULL`),
    index('oauth_consents_client_idx').on(table.clientId),
    index('oauth_consents_user_idx').on(table.userId),
  ],
);

export type OauthConsent = typeof oauthConsents.$inferSelect;
export type NewOauthConsent = typeof oauthConsents.$inferInsert;
