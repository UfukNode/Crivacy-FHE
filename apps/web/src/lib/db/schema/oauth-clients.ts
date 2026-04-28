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

import { firms } from './firms';
import { firmUsers } from './users';

/**
 * `oauth_clients` — registered OAuth/OIDC clients owned by a firm.
 *
 * One firm may register multiple clients (e.g. a live web app + a
 * staging copy + a native mobile client). Each client carries its
 * own `client_id`, hashed `client_secret`, and the whitelist of
 * redirect URIs + allowed scopes the `authorize` endpoint enforces.
 *
 *   - `client_id` is the public identifier a firm embeds in the
 *     authorize URL. Globally unique, never changes, not a secret.
 *   - `client_secret_hash` is bcrypt (cost from auth config). The raw
 *     secret is surfaced to the firm exactly once at create / rotate
 *     time and then lives only in the firm's backend.
 *   - `redirect_uris` is a list of exact-match callback URLs. Wildcard
 *     matching is deliberately NOT supported — every OAuth redirect
 *     hijack CVE starts with a wildcard rule.
 *   - `allowed_scopes` is the per-client ceiling. The firm can always
 *     request a subset; never a superset. Added defensively even
 *     though the tier caps every firm to the same master list today.
 *   - `is_public_client` flips the PKCE requirement and disables
 *     client_secret authentication for single-page apps.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: varchar('client_id', { length: 64 }).notNull(),
    clientSecretHash: text('client_secret_hash'),
    name: varchar('name', { length: 128 }).notNull(),
    /** Marketing copy shown on the consent screen under the firm name. */
    description: text('description'),
    /** Absolute URL for the firm's logo shown on the consent screen. */
    logoUrl: text('logo_url'),
    /**
     * Absolute URL for the firm's homepage — linked from consent so
     * users can verify the client before approving.
     */
    homepageUrl: text('homepage_url'),
    redirectUris: text('redirect_uris')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    allowedScopes: text('allowed_scopes')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    isPublicClient: boolean('is_public_client').notNull().default(false),
    /**
     * Consent cache TTL in days. Firm may shorten but never exceed the
     * product cap (enforced in the handler). 90-day default matches
     * common OAuth consumer expectations.
     */
    consentTtlDays: integer('consent_ttl_days').notNull().default(90),
    /** Config knobs that don't justify their own column yet. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdByFirmUserId: uuid('created_by_firm_user_id').references(() => firmUsers.id, {
      onDelete: 'set null',
    }),
    /**
     * Consecutive wrong `client_secret` submissions to `/oauth/token`.
     * Reset to 0 on a successful verify. The 5th miss writes
     * `secret_locked_until` + fires an audit alarm.
     */
    failedSecretAttempts: integer('failed_secret_attempts').notNull().default(0),
    /**
     * Temporary lockout timestamp — `/token` refuses the client
     * until this passes. Distinct from `revoked_at` (terminal,
     * dashboard-only) and self-heals after the 15-minute window.
     */
    secretLockedUntil: timestamp('secret_locked_until', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_clients_client_id_key').on(table.clientId),
    index('oauth_clients_firm_id_idx').on(table.firmId),
    index('oauth_clients_revoked_at_idx').on(table.revokedAt),
  ],
);

export type OauthClient = typeof oauthClients.$inferSelect;
export type NewOauthClient = typeof oauthClients.$inferInsert;
