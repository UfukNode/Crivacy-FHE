import { sql } from 'drizzle-orm';
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

import { adminUserRoleEnum, firmUserRoleEnum } from './enums';
import { firms } from './firms';

/**
 * `firm_users` — dashboard users that belong to a firm. Authenticated with
 * argon2id (password_hash) + TOTP (totp_secret, AES-GCM encrypted with the
 * app-level data key — the raw Base32 secret is never stored).
 *
 * Uniqueness is (firm_id, lower(email)) because two different firms are
 * allowed to invite the same real-world email address. We enforce
 * case-insensitive uniqueness via a functional unique index.
 *
 * Brute-force protection: `failed_login_count` is incremented on every
 * wrong password/TOTP; after a threshold the row is locked
 * (`locked_at`, `locked_until`) until an admin clears it or the timer
 * expires. Rate limiting also applies per IP at the middleware layer
 * (step 6 of PLAN.md §20).
 */
export const firmUsers = pgTable(
  'firm_users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    // Nullable to model the "invited but not yet accepted" state:
    // an admin-created owner row exists with password_hash = NULL
    // until the invitee claims the token and sets their password.
    // The login handler rejects null hashes as `invalid_password`.
    passwordHash: text('password_hash'),
    totpSecretCiphertext: text('totp_secret_ciphertext'),
    totpSecretNonce: text('totp_secret_nonce'),
    totpKeyVersion: integer('totp_key_version'),
    totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true, mode: 'date' }),
    role: firmUserRoleEnum('role').notNull().default('member'),
    invitedBy: uuid('invited_by'),
    invitedAt: timestamp('invited_at', { withTimezone: true, mode: 'date' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    lastLoginIp: text('last_login_ip'),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    /** F-XCC-AE Layer 1 — earliest wrong-pwd of the current accumulating run. */
    failedLoginFirstAt: timestamp('failed_login_first_at', { withTimezone: true, mode: 'date' }),
    passwordChangedAt: timestamp('password_changed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('firm_users_firm_id_email_key').on(table.firmId, sql`lower(${table.email})`),
    index('firm_users_firm_id_idx').on(table.firmId),
    index('firm_users_invited_by_idx').on(table.invitedBy),
  ],
);

export type FirmUser = typeof firmUsers.$inferSelect;
export type NewFirmUser = typeof firmUsers.$inferInsert;

/**
 * `admin_users` — Crivacy team members with access to `/admin`. TOTP is
 * strongly recommended but not mandatory at creation time — a newly-seeded
 * superadmin can log in with email + password only. Once enrolled, the
 * two-step login flow (password → TOTP challenge) becomes mandatory.
 * Separate from `firm_users` to prevent accidental privilege escalation
 * via shared rows and to allow different password/TOTP rotation policies.
 */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: varchar('email', { length: 320 }).notNull(),
    displayName: varchar('display_name', { length: 128 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    totpSecretCiphertext: text('totp_secret_ciphertext'),
    totpSecretNonce: text('totp_secret_nonce'),
    totpKeyVersion: integer('totp_key_version'),
    totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true, mode: 'date' }),
    role: adminUserRoleEnum('role').notNull().default('support'),
    ipAllowlist: text('ip_allowlist')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    lastLoginIp: text('last_login_ip'),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    /** F-XCC-AE Layer 1 — earliest wrong-pwd of the current accumulating run. */
    failedLoginFirstAt: timestamp('failed_login_first_at', { withTimezone: true, mode: 'date' }),
    passwordChangedAt: timestamp('password_changed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('admin_users_email_key').on(sql`lower(${table.email})`)],
);

export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;
