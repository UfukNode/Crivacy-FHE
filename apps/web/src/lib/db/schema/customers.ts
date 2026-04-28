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

import { customerKycLevelEnum, customerStatusEnum } from './enums';

// ---------------------------------------------------------------------------
// customers
// ---------------------------------------------------------------------------

/**
 * `customers` — end-user accounts that go through the Didit KYC flow and
 * receive chain-backed credentials. A customer registers via the public
 * `/auth/register` endpoint or vian Ethereum wallet login, verifies
 * their email (if provided), and progresses through KYC levels (kyc_0 ..
 * kyc_4) as verification phases complete.
 *
 * Wallet-only users may have `email = NULL` and `password_hash = NULL`.
 * They can optionally add an email and/or password later from settings.
 *
 * **Non-custodial PII policy**: Crivacy stores ZERO raw PII columns
 * sourced from Didit decisions. The customer's name, date-of-birth,
 * nationality, document details, and address live exclusively in
 * Didit's user store. Crivacy keeps `kyc_level` (verification tier),
 * `kyc_score` (numeric), `kyc_fields_locked` (lifecycle gate), and the
 * credential whose `proof_hash` cryptographically commits to
 * the underlying PII via the schema in `proof_schemas`. See
 * `.claude/PII-PURGE-AND-COMPOSITE-HASH.md` for the full doctrine.
 *
 * Soft delete via `deleted_at`; the row is never physically removed so audit
 * and compliance history (GDPR/KVKK) survives. The unique email constraint
 * is partial — it only applies to non-deleted rows so a customer can
 * re-register after account deletion with the same email.
 *
 * Brute-force protection: `failed_login_attempts` is incremented on every
 * wrong password; after a threshold the row is locked (`locked_at`,
 * `lock_reason`) until an admin clears it. Rate limiting also applies per IP
 * at the middleware layer.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: varchar('email', { length: 320 }),
    passwordHash: text('password_hash'),
    displayName: varchar('display_name', { length: 100 }),
    status: customerStatusEnum('status').notNull().default('pending_verification'),
    kycLevel: customerKycLevelEnum('kyc_level').notNull().default('kyc_0'),
    kycScore: integer('kyc_score').notNull().default(0),

    /** E.164 format phone number, nullable until customer provides it. */
    phone: text('phone'),

    // Identity + address PII (full_name / date_of_birth / nationality /
    // document_* / address_*) is INTENTIONALLY NOT a column on this
    // table. See the table-level docblock for the non-custodial policy
    // and `.claude/PII-PURGE-AND-COMPOSITE-HASH.md` for the migration
    // (20260509000000_pii_purge_and_proof_schemas.sql) that dropped
    // those columns.

    /**
     * Set to TRUE after the first successful KYC approval. Used by the
     * webhook handler as a lifecycle gate — once locked, only an admin
     * `reset_kyc` action (or a Didit-driven revoke) can flip it back to
     * FALSE.
     */
    kycFieldsLocked: boolean('kyc_fields_locked').notNull().default(false),

    /** UUID pointing to the avatar file in object storage (nullable). */
    avatarStorageKey: uuid('avatar_storage_key'),

    // -- Security / lockout ------------------------------------------------
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    lockReason: text('lock_reason'),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    /** F-XCC-AE Layer 1 — earliest wrong-pwd of the current accumulating run. */
    failedLoginFirstAt: timestamp('failed_login_first_at', { withTimezone: true, mode: 'date' }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),

    // -- Compliance: ToS + privacy-policy acceptance tracking -------------
    /**
     * Stamped when the customer explicitly agreed to the Terms of
     * Service + Privacy Policy at registration (AUD-X-COMP-006).
     * Null for pre-compliance rows registered before 2026-04-24; new
     * registrations always set this + `termsVersion`.
     */
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true, mode: 'date' }),
    /** Version string (e.g. `"2026-04-24"`) of the policy pack that was accepted. */
    termsVersion: varchar('terms_version', { length: 16 }),

    // -- Lifecycle timestamps -----------------------------------------------
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    onboardingDismissedAt: timestamp('onboarding_dismissed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    /**
     * Set when Didit signals that the customer's user-entity is
     * deleted (`user.data.updated` with `deleted_at`) or blocked
     * (`user.status.updated` with `BLOCKED`/`Declined`). Drives the
     * start-identity / start-address 409 guard so a stale tab from
     * before the revoke cannot silently start a new session.
     * Distinct from `deletedAt` (our own soft-delete) — a Didit-revoke
     * does NOT delete the account locally; the customer can still
     * authenticate and re-verify from scratch.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    /** Discriminator: `didit_user_deleted` | `didit_user_blocked`. */
    revokedReason: varchar('revoked_reason', { length: 64 }),

    // -- Per-customer decline cap (anti-Didit-budget-burn gate) ----------
    /**
     * Number of consecutive Didit declines since the last approval.
     * Incremented in every decline detection surface (webhook, SSE
     * pull-fallback, reconciler forward-drift); reset to 0 inside the
     * mint pipeline transaction on successful credential issue. Reads
     * are hot-path (every start-identity / start-address call) so the
     * partial index `customers_decline_locked_idx` lights up the
     * non-zero rows.
     */
    consecutiveKycDeclines: integer('consecutive_kyc_declines').notNull().default(0),
    /**
     * UTC timestamp of the most recent decline. Paired with
     * `consecutiveKycDeclines` to bound the lockout window: the gate
     * trips only while `last_decline_at` is inside the cooldown
     * window, so a customer who waits past the cooldown naturally
     * regains start-session access without admin intervention.
     */
    lastDeclineAt: timestamp('last_decline_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('customers_email_key')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.deletedAt} IS NULL AND ${table.email} IS NOT NULL`),
    uniqueIndex('customers_phone_key')
      .on(table.phone)
      .where(sql`${table.deletedAt} IS NULL AND ${table.phone} IS NOT NULL`),
    index('customers_status_idx').on(table.status),
    index('customers_kyc_level_idx').on(table.kycLevel),
    index('customers_revoked_at_idx')
      .on(table.revokedAt)
      .where(sql`${table.revokedAt} IS NOT NULL`),
    index('customers_decline_locked_idx')
      .on(table.lastDeclineAt)
      .where(sql`${table.consecutiveKycDeclines} > 0`),
  ],
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

// ---------------------------------------------------------------------------
// customer_sessions
// ---------------------------------------------------------------------------

/**
 * `customer_sessions` — JWT sessions for customer authentication. One row per
 * refresh token issued. The `jwt_jti` column matches the `jti` claim inside
 * the access token, enabling instant revocation by marking `revoked_at`.
 *
 * Device metadata (`device_name`, `city`) is resolved at creation time from
 * the user-agent header and IP geolocation respectively. `last_active_at` is
 * bumped on each authenticated request to support "active sessions" UI.
 *
 * Cleanup of expired rows runs via pg-boss scheduled job.
 */
export const customerSessions = pgTable(
  'customer_sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    jwtJti: uuid('jwt_jti').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    refreshTokenVersion: integer('refresh_token_version').notNull().default(1),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Friendly device name parsed from the user-agent header at session creation. */
    deviceName: text('device_name'),
    /** City geo-resolved from the client IP at session creation. */
    city: text('city'),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: varchar('revoked_reason', { length: 64 }),
    /** Whether the user checked "Remember me" at login. Controls refresh cookie persistence. */
    rememberMe: boolean('remember_me').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /**
     * Previous refresh-token hash stash — used by the 5s race-loss
     * grace window in `/api/customer/auth/refresh`. Drizzle drift fix
     * (2026-04-23): DB'de zaten var, schema güncellendi.
     */
    previousRefreshTokenHash: text('previous_refresh_token_hash'),
    previousRotationAt: timestamp('previous_rotation_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('customer_sessions_jwt_jti_key').on(table.jwtJti),
    index('customer_sessions_customer_id_idx').on(table.customerId),
    index('customer_sessions_refresh_expires_at_idx').on(table.refreshExpiresAt),
    index('customer_sessions_expires_at_idx').on(table.expiresAt),
    index('customer_sessions_previous_refresh_hash_idx').on(table.previousRefreshTokenHash),
  ],
);

export type CustomerSession = typeof customerSessions.$inferSelect;
export type NewCustomerSession = typeof customerSessions.$inferInsert;

// ---------------------------------------------------------------------------
// email_verification_tokens
// ---------------------------------------------------------------------------

/**
 * `email_verification_tokens` — one-time tokens sent to a customer's email
 * address during registration. The raw token is never stored; only its
 * SHA-256 hash is persisted. `used_at` is stamped when the customer clicks
 * the verification link, after which the token cannot be reused.
 *
 * Multiple tokens may exist for a single customer (re-send scenario); the
 * composite index on `(customer_id, created_at)` supports rate-limit queries
 * ("how many tokens were sent in the last N minutes?").
 */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** SHA-256 hash of the raw verification token / 6-digit code. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    /** Number of wrong code attempts against this token (max 5 then invalidated). */
    attempts: integer('attempts').notNull().default(0),
    /** Set when the code is invalidated (max attempts, or superseded by a new code). */
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('email_verification_tokens_token_hash_idx').on(table.tokenHash),
    index('email_verification_tokens_customer_created_idx').on(
      table.customerId,
      table.createdAt,
    ),
  ],
);

export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type NewEmailVerificationToken = typeof emailVerificationTokens.$inferInsert;

// ---------------------------------------------------------------------------
// password_reset_tokens
// ---------------------------------------------------------------------------

/**
 * `password_reset_tokens` — one-time tokens for the "forgot password" flow.
 * Same hash-only storage strategy as `email_verification_tokens`. The
 * `ip_address` column records the IP that requested the reset for audit
 * purposes.
 *
 * The composite index on `(customer_id, created_at)` supports rate-limit
 * queries ("how many resets were requested in the last N minutes?").
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** SHA-256 hash of the raw reset token / 6-digit code. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    /** Number of wrong code attempts against this token (max 5 then invalidated). */
    attempts: integer('attempts').notNull().default(0),
    /** Set when the code is invalidated (max attempts, or superseded by a new code). */
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true, mode: 'date' }),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('password_reset_tokens_token_hash_idx').on(table.tokenHash),
    index('password_reset_tokens_customer_created_idx').on(table.customerId, table.createdAt),
  ],
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// ---------------------------------------------------------------------------
// email_send_log
// ---------------------------------------------------------------------------

/**
 * `email_send_log` — append-only log of every transactional email sent to
 * any user (customer, firm user, or admin). Used primarily for rate limiting:
 * before sending an email, the service checks how many emails of a given type
 * were sent to the same user in the last N minutes.
 *
 * `user_id` is deliberately not a foreign key because it may reference
 * customers, firm_users, or admin_users depending on context. Logical
 * integrity is enforced in the service layer.
 */
export const emailSendLog = pgTable(
  'email_send_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    emailType: varchar('email_type', { length: 32 }).notNull(),
    recipientEmail: varchar('recipient_email', { length: 320 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('email_send_log_user_created_idx').on(table.userId, table.createdAt),
    index('email_send_log_user_type_created_idx').on(
      table.userId,
      table.emailType,
      table.createdAt,
    ),
  ],
);

export type EmailSendLogEntry = typeof emailSendLog.$inferSelect;
export type NewEmailSendLogEntry = typeof emailSendLog.$inferInsert;
