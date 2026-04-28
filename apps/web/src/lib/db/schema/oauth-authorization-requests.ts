import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { customers } from './customers';
import { oauthClients } from './oauth-clients';

/**
 * `oauth_authorization_requests` — transient server-side record of an
 * in-flight OAuth `authorize` call.
 *
 * The Authorization Code flow is inherently multi-step — user may need
 * to sign up, verify their email, finish KYC, or return after a
 * browser restart before they ever see the consent screen. We stash
 * the original authorize query (`redirect_uri`, `scope`, `state`,
 * PKCE challenge) in this table keyed by `request_id` and hand the
 * browser a cookie or `?continue=` param that resumes the flow
 * exactly where it left off.
 *
 *   - `request_id` is a 32-byte random value. It is NOT the auth code
 *     — it never leaves Crivacy, only ever appears inside our own URL
 *     path (`?continue=<request_id>`).
 *   - `code_challenge` / `code_challenge_method` are captured at
 *     authorize time. The user may complete KYC or signup between
 *     authorize and consent; PKCE must verify against *this* original
 *     challenge, not whatever the attacker might rewrite later.
 *   - `completed_at` is set once we redirect the user back to the
 *     firm with a code. Completed rows stay in place for 24h so
 *     duplicate `consent` clicks are idempotent.
 *   - `expires_at` is set to `created_at + 15 minutes`. The user can
 *     resume within that window; beyond it we force them to restart
 *     from the firm.
 */
export const oauthAuthorizationRequests = pgTable(
  'oauth_authorization_requests',
  {
    requestId: varchar('request_id', { length: 64 }).primaryKey(),
    clientId: uuid('oauth_client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    /**
     * Populated once the user has authenticated inside the authorize
     * flow. NULL while the user is still on signup / login / KYC.
     */
    userId: uuid('user_id').references(() => customers.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    /** Canonical space-separated scope string (pre-parse, pre-sort). */
    scope: text('scope').notNull(),
    /** Opaque CSRF token from the firm, echoed back unchanged. */
    state: text('state'),
    codeChallenge: text('code_challenge'),
    codeChallengeMethod: varchar('code_challenge_method', { length: 8 }),
    /** BCP-47 locale hint from the firm for the consent UI. */
    uiLocales: varchar('ui_locales', { length: 32 }),
    /** OIDC `nonce` — if present, echoed into the id_token `nonce` claim. */
    nonce: text('nonce'),
    /**
     * IP + UA captured at authorize time. Consent must be submitted
     * from the same browser session — helps catch stolen request_id.
     */
    ip: text('ip'),
    userAgent: text('user_agent'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('oauth_auth_requests_client_id_idx').on(table.clientId),
    index('oauth_auth_requests_user_id_idx').on(table.userId),
    index('oauth_auth_requests_expires_at_idx').on(table.expiresAt),
  ],
);

export type OauthAuthorizationRequest = typeof oauthAuthorizationRequests.$inferSelect;
export type NewOauthAuthorizationRequest = typeof oauthAuthorizationRequests.$inferInsert;
