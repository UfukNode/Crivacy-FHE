import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { apiKeyModeEnum, sessionKindEnum } from './enums';
import { firms } from './firms';
import { firmUsers } from './users';

/**
 * `api_keys` — B2B API keys issued to firms. The raw secret exists exactly
 * once: at creation time, returned in the response body, never persisted.
 *
 * Storage layout:
 *   * `prefix` (12 chars) — visible segment of the key, plaintext, indexed.
 *     Used for O(1) lookup before the expensive bcrypt compare.
 *   * `hash` — bcrypt(raw_key, cost=12). Key lookup is:
 *         1. SELECT ... WHERE prefix = $1 AND revoked_at IS NULL
 *         2. bcrypt.compare(raw, hash)
 *   * `hash_algorithm` + `hash_parameters` — snapshotted so we can rotate to
 *     argon2id or raise bcrypt cost later without a data migration.
 *
 * Scopes are stored as `text[]` (not `pgEnum`) because the values contain
 * `:` which Postgres enums disallow. Validation of allowed scopes happens
 * at the Zod boundary against `ApiKeyScope` from `@crivacy/shared-types`.
 *
 * Rotation uses a grace window: the old key keeps `revoked_at IS NULL` for
 * `API_KEY_GRACE_PERIOD_HOURS` after rotation, then the background job at
 * PLAN.md step 11 stamps `revoked_at = now()`.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    prefix: varchar('prefix', { length: 12 }).notNull(),
    hash: text('hash').notNull(),
    hashAlgorithm: varchar('hash_algorithm', { length: 32 }).notNull().default('bcrypt'),
    hashParameters: varchar('hash_parameters', { length: 64 }).notNull().default('cost=12'),
    name: varchar('name', { length: 128 }).notNull(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    mode: apiKeyModeEnum('mode').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => firmUsers.id, {
      onDelete: 'set null',
    }),
    rotatesFromId: uuid('rotates_from_id'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    lastUsedIp: text('last_used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: varchar('revoked_reason', { length: 128 }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('api_keys_prefix_key').on(table.prefix),
    index('api_keys_firm_id_idx').on(table.firmId),
    index('api_keys_mode_idx').on(table.mode),
    index('api_keys_revoked_at_idx').on(table.revokedAt),
    index('api_keys_rotates_from_id_idx').on(table.rotatesFromId),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

/**
 * `sessions` — dashboard JWT sessions. One row per refresh token issued. The
 * `jwt_jti` column matches the `jti` claim inside the access token, enabling
 * instant revocation by deleting/marking the row.
 *
 * `user_id` carries either a `firm_users.id` or `admin_users.id`. We do not
 * use a foreign key because the kind is indirected via `user_kind`. Logical
 * integrity is enforced in the repository layer. Cleanup of expired rows
 * runs via pg-boss (step 11).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    userKind: sessionKindEnum('user_kind').notNull(),
    jwtJti: uuid('jwt_jti').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    refreshTokenVersion: integer('refresh_token_version').notNull().default(1),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: varchar('revoked_reason', { length: 64 }),
    /**
     * Previous refresh-token hash stash — used by the 5s race-loss
     * grace window in the refresh handler. When a fresh rotation
     * overwrites `refresh_token_hash`, the old hash lives here long
     * enough for a concurrent-tab loser to detect the race and return
     * 200 without re-rotating. See `/api/internal/auth/refresh`.
     */
    previousRefreshTokenHash: text('previous_refresh_token_hash'),
    previousRotationAt: timestamp('previous_rotation_at', { withTimezone: true, mode: 'date' }),
    /**
     * Whether the user checked "Remember me" at login. Controls
     * refresh cookie persistence across rotations — the refresh
     * handler reads this to decide between session-scoped
     * (no Max-Age) and persistent (maxAge = refreshTtl) cookies.
     * Default `false` so a forgotten login flow never unexpectedly
     * sticks. Added 2026-04-23 for AUD-FRM-AUTH-003.
     */
    rememberMe: boolean('remember_me').notNull().default(false),
  },
  (table) => [
    uniqueIndex('sessions_jwt_jti_key').on(table.jwtJti),
    index('sessions_user_id_idx').on(table.userId, table.userKind),
    index('sessions_refresh_expires_at_idx').on(table.refreshExpiresAt),
    index('sessions_expires_at_idx').on(table.expiresAt),
    index('sessions_previous_refresh_hash_idx').on(table.previousRefreshTokenHash),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
