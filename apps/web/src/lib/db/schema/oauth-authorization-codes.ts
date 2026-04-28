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
 * `oauth_authorization_codes` — the short-lived, single-use artifact
 * the firm exchanges for tokens at `/oauth/token`.
 *
 * Raw codes are 32 bytes of CSPRNG entropy encoded as URL-safe
 * base64. Only the SHA-256 hash lives here; the raw value is emitted
 * in the redirect-to-firm URL exactly once.
 *
 *   - `used_at` is the burn flag. Any second exchange attempt against
 *     the same code triggers the "code re-use" defence: we MUST
 *     invalidate every access/refresh token issued for this code and
 *     reject the request (RFC 9700 §2.1.1).
 *   - `ip_bound_to` is the IP that received the `/authorize` redirect.
 *     The `/token` exchange must originate from the same IP (server-
 *     side firm integrations live on a single IP), which catches the
 *     majority of code-interception attacks before PKCE even runs.
 *   - `code_challenge` / `code_challenge_method` are copied from the
 *     originating authorization request so the `/token` handler has
 *     one source of truth without a join.
 *   - `expires_at` is `created_at + 60 seconds`. RFC 6749 ceiling is
 *     10 minutes; our product needs much less — tight window means
 *     less replay surface.
 */
export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    clientId: uuid('oauth_client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** Canonical space-separated scope granted at consent time. */
    scope: text('scope').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    nonce: text('nonce'),
    codeChallenge: text('code_challenge'),
    codeChallengeMethod: text('code_challenge_method'),
    ipBoundTo: text('ip_bound_to'),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_auth_codes_code_hash_key').on(table.codeHash),
    index('oauth_auth_codes_client_id_idx').on(table.clientId),
    index('oauth_auth_codes_user_id_idx').on(table.userId),
    index('oauth_auth_codes_expires_at_idx').on(table.expiresAt),
  ],
);

export type OauthAuthorizationCode = typeof oauthAuthorizationCodes.$inferSelect;
export type NewOauthAuthorizationCode = typeof oauthAuthorizationCodes.$inferInsert;
