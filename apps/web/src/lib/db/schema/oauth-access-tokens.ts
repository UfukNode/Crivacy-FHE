import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { customers } from './customers';
import { oauthAuthorizationCodes } from './oauth-authorization-codes';
import { oauthClients } from './oauth-clients';
import { oauthConsents } from './oauth-consents';

/**
 * `oauth_access_tokens` — opaque bearer tokens the firm sends to
 * `/oauth/userinfo` (and future resource endpoints) in exchange for
 * the user's disclosure payload.
 *
 * We chose opaque over JWT specifically so consent revoke is instant:
 * flipping `revoked_at` kills every live token in one write. A JWT
 * would stay valid until its `exp` unless we maintained a denylist,
 * which is effectively this table anyway — so we cut the middleman.
 *
 *   - `token_hash` is SHA-256 of the 32-byte random value emitted to
 *     the firm. Raw tokens never land in the DB.
 *   - `consent_id` ties the token to the consent row it was issued
 *     against. Revoking consent cascades via the FK+handler pair.
 *   - `authorization_code_hash` tracks the exact code the token was
 *     minted from. If that code is later detected as replayed, every
 *     token carrying the same reference is invalidated (RFC 9700
 *     §2.1.1 code-reuse mitigation).
 *   - `expires_at` defaults to 1 hour. Long-lived access tokens are
 *     an anti-pattern even with opaque storage; firms re-mint via
 *     refresh tokens (separate follow-up).
 */
export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    clientId: uuid('oauth_client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    consentId: uuid('oauth_consent_id')
      .notNull()
      .references(() => oauthConsents.id, { onDelete: 'cascade' }),
    /**
     * Hash of the authorization code that minted this token. Set on
     * insert, never mutated — the `/token` replay defence flips
     * `revoked_at` on every row sharing this reference.
     */
    authorizationCodeHash: text('authorization_code_hash').references(
      () => oauthAuthorizationCodes.codeHash,
      { onDelete: 'set null' },
    ),
    scope: text('scope').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: text('revoked_reason'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_access_tokens_token_hash_key').on(table.tokenHash),
    index('oauth_access_tokens_client_idx').on(table.clientId),
    index('oauth_access_tokens_user_idx').on(table.userId),
    index('oauth_access_tokens_consent_idx').on(table.consentId),
    index('oauth_access_tokens_code_idx').on(table.authorizationCodeHash),
    index('oauth_access_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

export type OauthAccessToken = typeof oauthAccessTokens.$inferSelect;
export type NewOauthAccessToken = typeof oauthAccessTokens.$inferInsert;
