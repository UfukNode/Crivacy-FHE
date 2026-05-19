/**
 * Admin repository — Drizzle queries for admin API endpoints.
 *
 * Provides lookup/mutation functions for admin_users, firms (CRUD),
 * status components/incidents, and global audit log.
 *
 * @module
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import { AdminError, PG_UNIQUE_VIOLATION } from '@/lib/admin/errors';
import { generateInviteToken, hashInviteToken } from '@/lib/auth/invite-token';
import { FAILED_LOGIN_DECAY_SECONDS } from '@/lib/auth/lockout';
import type { CrivacyDatabase } from '@/lib/db/client';
import { syncFirmUserHierarchyRole } from '@/lib/rbac';
import {
  adminUsers,
  apiKeys,
  auditLog,
  customerSessions,
  firmSettings,
  firmUserInvites,
  firmUserRecoveryCodes,
  firmUsers,
  firms,
  oauthClients,
  sessions,
  statusComponents,
  statusHistory,
  statusIncidents,
} from '@/lib/db/schema';

import type { AdminSessionRow, AdminUserRow } from '../middleware/admin-route';

/* ---------- Admin auth lookups ---------- */

/** Minimal admin user row for login. */
export interface AdminLoginUserRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'superadmin' | 'admin' | 'support';
  readonly passwordHash: string;
  readonly totpSecretCiphertext: string | null;
  readonly totpSecretNonce: string | null;
  readonly totpKeyVersion: number | null;
  readonly totpEnrolledAt: Date | null;
  readonly ipAllowlist: string[];
  readonly lockedAt: Date | null;
  readonly lockedUntil: Date | null;
  readonly failedLoginCount: number;
}

/**
 * Find an admin user by email (case-insensitive).
 */
export async function findAdminUserByEmail(
  db: CrivacyDatabase,
  email: string,
): Promise<AdminLoginUserRow | null> {
  const rows = await db
    .select()
    .from(adminUsers)
    .where(eq(sql`lower(${adminUsers.email})`, email.toLowerCase()))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    passwordHash: row.passwordHash,
    totpSecretCiphertext: row.totpSecretCiphertext,
    totpSecretNonce: row.totpSecretNonce,
    totpKeyVersion: row.totpKeyVersion,
    totpEnrolledAt: row.totpEnrolledAt,
    ipAllowlist: row.ipAllowlist,
    lockedAt: row.lockedAt,
    lockedUntil: row.lockedUntil,
    failedLoginCount: row.failedLoginCount,
  };
}

/**
 * Find an admin user by ID with full login fields (TOTP, lock status, etc).
 * Used in step 2 of the two-step login flow to decrypt the TOTP secret.
 */
export async function findAdminLoginUserById(
  db: CrivacyDatabase,
  userId: string,
): Promise<AdminLoginUserRow | null> {
  const rows = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.id, userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    passwordHash: row.passwordHash,
    totpSecretCiphertext: row.totpSecretCiphertext,
    totpSecretNonce: row.totpSecretNonce,
    totpKeyVersion: row.totpKeyVersion,
    totpEnrolledAt: row.totpEnrolledAt,
    ipAllowlist: row.ipAllowlist,
    lockedAt: row.lockedAt,
    lockedUntil: row.lockedUntil,
    failedLoginCount: row.failedLoginCount,
  };
}

/**
 * Find an admin user by ID (for middleware).
 */
export async function findAdminUserByIdForMiddleware(
  db: CrivacyDatabase,
  userId: string,
): Promise<AdminUserRow | null> {
  const rows = await db
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      displayName: adminUsers.displayName,
      role: adminUsers.role,
      ipAllowlist: adminUsers.ipAllowlist,
      lockedAt: adminUsers.lockedAt,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Find session by jti (for admin middleware — reuses sessions table).
 */
export async function findAdminSessionByJtiForMiddleware(
  db: CrivacyDatabase,
  jti: string,
): Promise<AdminSessionRow | null> {
  const rows = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      userKind: sessions.userKind,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(eq(sessions.jwtJti, jti))
    .limit(1);
  return rows[0] ?? null;
}

/* ---------- Admin auth mutations ---------- */

/**
 * Atomically increment the failed-login counter and trip the lock
 * if and only if this commit pushes the counter past the threshold.
 *
 * BUG #59 fix: see `incrementFailedLoginOrLock` in
 * `repositories/dashboard.ts` for the full rationale — same race
 * pattern as the firm side, same fix shape.
 *
 * F-XCC-AE Layer 1 (sliding-window decay): mirrors the firm helper
 * exactly; see the comment on `incrementFailedLoginOrLock` in
 * `repositories/dashboard.ts` for the decay/trip semantic.
 */
export async function incrementAdminFailedLoginOrLock(
  db: CrivacyDatabase,
  userId: string,
  maxAttempts: number,
  lockUntil: Date,
  now: Date,
): Promise<{ failedLoginCount: number; justLocked: boolean }> {
  const nowIso = now.toISOString();
  const lockUntilIso = lockUntil.toISOString();
  const decayed = sql`(failed_login_first_at IS NULL OR EXTRACT(EPOCH FROM (${nowIso}::timestamptz - failed_login_first_at)) > ${FAILED_LOGIN_DECAY_SECONDS})`;
  const lockTrips = sql`(NOT ${decayed} AND failed_login_count + 1 >= ${maxAttempts} AND (locked_until IS NULL OR locked_until <= ${nowIso}::timestamptz))`;
  const result = await db.execute<{ failed_login_count: number }>(
    sql`UPDATE admin_users
        SET locked_at = CASE
              WHEN ${lockTrips}
              THEN ${nowIso}::timestamptz
              ELSE locked_at
            END,
            locked_until = CASE
              WHEN ${lockTrips}
              THEN ${lockUntilIso}::timestamptz
              ELSE locked_until
            END,
            failed_login_count = CASE
              WHEN ${lockTrips}
              THEN 0
              WHEN ${decayed}
              THEN 1
              ELSE failed_login_count + 1
            END,
            failed_login_first_at = CASE
              WHEN ${lockTrips}
              THEN NULL
              WHEN ${decayed}
              THEN ${nowIso}::timestamptz
              ELSE failed_login_first_at
            END,
            updated_at = ${nowIso}
        WHERE id = ${userId}
        RETURNING failed_login_count`,
  );
  const row = result.rows[0] as { failed_login_count: number } | undefined;
  const failedLoginCount = row?.failed_login_count ?? 0;
  return { failedLoginCount, justLocked: failedLoginCount === 0 };
}

/**
 * Reset failed login count and update last login for admin user.
 */
export async function resetAdminFailedLogin(
  db: CrivacyDatabase,
  userId: string,
  now: Date,
  ip: string | null,
): Promise<void> {
  await db
    .update(adminUsers)
    .set({
      failedLoginCount: 0,
      // F-XCC-AE Layer 1 — clear the decay window on success so the
      // next post-success wrong-pwd starts a fresh accumulating run.
      failedLoginFirstAt: null,
      lastLoginAt: now,
      lastLoginIp: ip,
      lockedAt: null,
      lockedUntil: null,
    })
    .where(eq(adminUsers.id, userId));
}

/**
 * Insert an admin session row (reuses the sessions table).
 */
export async function insertAdminSession(
  db: CrivacyDatabase,
  record: Record<string, unknown>,
): Promise<{ id: string }> {
  const result = await db
    .insert(sessions)
    .values(record as typeof sessions.$inferInsert)
    .returning({ id: sessions.id });
  const row = result[0];
  if (row === undefined) throw new Error('Failed to insert admin session');
  return row;
}

/**
 * Revoke an admin session.
 */
export async function revokeAdminSession(
  db: CrivacyDatabase,
  sessionId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(eq(sessions.id, sessionId));
}

/**
 * Revoke ALL non-revoked sessions for a given user (single session enforcement).
 * Called before inserting a new session on login.
 */
export async function revokeAllAdminSessions(
  db: CrivacyDatabase,
  userId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.userId, userId), eq(sessions.userKind, 'admin'), isNull(sessions.revokedAt)));
}

/* ---------- Firms CRUD ---------- */

/** Firm list item shape for admin. */
export interface AdminFirmListItem {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly tier: string;
  readonly contactEmail: string;
  readonly countryCode: string | null;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

/**
 * List all firms with optional filters.
 */
export async function listFirmsForAdmin(
  db: CrivacyDatabase,
  opts: {
    readonly includeDeleted?: boolean | undefined;
    readonly tier?: string | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  } = {},
): Promise<{ firms: readonly AdminFirmListItem[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions = [];
  if (opts.includeDeleted !== true) {
    conditions.push(isNull(firms.deletedAt));
  }
  if (opts.tier !== undefined) {
    conditions.push(eq(firms.tier, opts.tier as (typeof firms.tier.enumValues)[number]));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: firms.id,
      name: firms.name,
      slug: firms.slug,
      tier: firms.tier,
      contactEmail: firms.contactEmail,
      countryCode: firms.countryCode,
      createdAt: firms.createdAt,
      deletedAt: firms.deletedAt,
    })
    .from(firms)
    .where(whereClause)
    .orderBy(desc(firms.createdAt))
    .limit(limit)
    .offset(offset);

  // Count query
  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(firms)
    .where(whereClause);
  const total = countResult[0]?.count ?? 0;

  return { firms: rows, total };
}

/**
 * Get a single firm by ID with full details for admin.
 */
export async function getFirmForAdmin(
  db: CrivacyDatabase,
  firmId: string,
): Promise<AdminFirmListItem | null> {
  const rows = await db
    .select({
      id: firms.id,
      name: firms.name,
      slug: firms.slug,
      tier: firms.tier,
      contactEmail: firms.contactEmail,
      countryCode: firms.countryCode,
      createdAt: firms.createdAt,
      deletedAt: firms.deletedAt,
    })
    .from(firms)
    .where(eq(firms.id, firmId))
    .limit(1);
  return rows[0] ?? null;
}

/** Hours of validity for the owner invitation token. */
export const FIRM_INVITE_TTL_HOURS = 72;

/**
 * Return true when `err` is a Postgres unique-violation raised by the
 * `firms_slug_key` partial index (the "two live firms can't share a
 * slug" constraint). Other 23505s (e.g. `firm_users_firm_id_email_key`)
 * should keep bubbling so the call site surfaces the right message.
 *
 * We match on the constraint name rather than the error message text
 * so translations / driver upgrades don't silently break the mapping.
 */
function isFirmSlugUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const record = err as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
  if (record.code !== PG_UNIQUE_VIOLATION) return false;
  const name = record.constraint ?? record.constraint_name;
  return name === 'firms_slug_key';
}

/**
 * Outcome of {@link createFirmForAdmin}. The `inviteToken` is raw
 * URL-safe random bytes (only the SHA-256 hash is stored); the caller
 * must transmit it exactly once, over the welcome email CTA, and then
 * discard it.
 */
export interface FirmCreationWithOwnerResult {
  readonly firmId: string;
  readonly firmUserId: string;
  readonly inviteToken: string;
  readonly expiresAt: Date;
}


/**
 * Create a firm, its settings, an inviting firm_user row (owner,
 * password-less until accept), and the single-use invitation token.
 *
 * All four writes live in the same transaction so a partial firm
 * without an invite never ends up in the DB — the caller sees either
 * the full result (with the raw token to email out) or an error.
 */
export async function createFirmForAdmin(
  db: CrivacyDatabase,
  input: {
    readonly name: string;
    readonly slug: string;
    readonly tier: string;
    readonly contactEmail: string;
    readonly countryCode?: string | undefined;
    readonly ownerEmail: string;
    readonly invitedByAdminId: string;
    readonly now: Date;
  },
): Promise<FirmCreationWithOwnerResult> {
  const rawToken = generateInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const expiresAt = new Date(
    input.now.getTime() + FIRM_INVITE_TTL_HOURS * 60 * 60 * 1000,
  );

  let result: { firmId: string; firmUserId: string };
  try {
    result = await db.transaction(async (tx) => {
    const firmInsert = await tx
      .insert(firms)
      .values({
        name: input.name,
        slug: input.slug,
        tier: input.tier as (typeof firms.tier.enumValues)[number],
        contactEmail: input.contactEmail,
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
      })
      .returning({ id: firms.id });
    const firmRow = firmInsert[0];
    if (firmRow === undefined) {
      throw new Error('Failed to create firm');
    }

    await tx.insert(firmSettings).values({ firmId: firmRow.id });

    // Owner row — password / TOTP are NULL until the invitee accepts.
    // `acceptedAt` stays NULL, serving as the "is-this-user-active?"
    // guard for login (password check falls through on null hash).
    const firmUserInsert = await tx
      .insert(firmUsers)
      .values({
        firmId: firmRow.id,
        email: input.ownerEmail,
        passwordHash: null,
        role: 'owner',
        invitedBy: input.invitedByAdminId,
        invitedAt: input.now,
      })
      .returning({ id: firmUsers.id });
    const firmUserRow = firmUserInsert[0];
    if (firmUserRow === undefined) {
      throw new Error('Failed to create firm owner');
    }

    await tx.insert(firmUserInvites).values({
      firmUserId: firmUserRow.id,
      tokenHash,
      createdByAdminId: input.invitedByAdminId,
      expiresAt,
      createdAt: input.now,
    });

    // BUG #41 fix: hierarchy role on `firm_users.role` is for display
    // + invariants only; effective permissions live in `user_roles`.
    // The owner lands with zero perms otherwise — they can log in but
    // cannot read their own dashboard.
    await syncFirmUserHierarchyRole(tx, firmUserRow.id, 'owner');

    return { firmId: firmRow.id, firmUserId: firmUserRow.id };
  });
  } catch (err) {
    if (isFirmSlugUniqueViolation(err)) {
      throw new AdminError(
        'firm_slug_taken',
        `The slug "${input.slug}" is already in use by another firm.`,
        { cause: err },
      );
    }
    throw err;
  }

  return {
    firmId: result.firmId,
    firmUserId: result.firmUserId,
    inviteToken: rawToken,
    expiresAt,
  };
}

/**
 * Shape returned by {@link consumeFirmUserInvite} when the token is
 * valid and the caller may proceed to set the password + TOTP.
 */
export interface ValidatedFirmInvite {
  readonly inviteId: string;
  readonly firmUserId: string;
  readonly firmId: string;
  readonly firmName: string;
  readonly email: string;
}

/**
 * Validate an invitation token by hashing it and looking up the row.
 * Returns the linked firm + user details when the row is unused and
 * not expired; returns `null` with a discriminated reason otherwise
 * so the caller can translate to the correct HTTP status (404/410).
 */
export async function lookupFirmUserInvite(
  db: CrivacyDatabase,
  rawToken: string,
  now: Date,
): Promise<
  | { readonly status: 'ok'; readonly invite: ValidatedFirmInvite }
  | { readonly status: 'not_found' }
  | { readonly status: 'used' }
  | { readonly status: 'expired' }
  | { readonly status: 'firm_deactivated' }
> {
  const tokenHash = hashInviteToken(rawToken);

  // `firms.deleted_at` is SELECTed alongside the rest so the business
  // layer can distinguish "firm still active" from "firm was
  // deactivated after the invite went out". Session / login / API-key
  // layers already refuse deactivated firms; declining the invite too
  // prevents a half-enrolled `firm_users` row — password hash + TOTP
  // secret set on an account that can never log in.
  const rows = await db
    .select({
      inviteId: firmUserInvites.id,
      usedAt: firmUserInvites.usedAt,
      expiresAt: firmUserInvites.expiresAt,
      firmUserId: firmUsers.id,
      email: firmUsers.email,
      acceptedAt: firmUsers.acceptedAt,
      firmId: firms.id,
      firmName: firms.name,
      firmDeletedAt: firms.deletedAt,
    })
    .from(firmUserInvites)
    .innerJoin(firmUsers, eq(firmUsers.id, firmUserInvites.firmUserId))
    .innerJoin(firms, eq(firms.id, firmUsers.firmId))
    .where(eq(firmUserInvites.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  if (row.usedAt !== null) return { status: 'used' };
  if (row.expiresAt.getTime() <= now.getTime()) return { status: 'expired' };
  if (row.firmDeletedAt !== null) return { status: 'firm_deactivated' };

  return {
    status: 'ok',
    invite: {
      inviteId: row.inviteId,
      firmUserId: row.firmUserId,
      firmId: row.firmId,
      firmName: row.firmName,
      email: row.email,
    },
  };
}

/**
 * Finalise an invitation: burn the token, write the password hash +
 * encrypted TOTP secret onto the firm_users row, and stamp
 * `accepted_at`. The caller must have already validated the token
 * and verified the TOTP code against the secret.
 *
 * Returns `false` when the row was raced (used under us); the caller
 * should treat that as `410 Gone`.
 */
export async function acceptFirmUserInvite(
  db: CrivacyDatabase,
  input: {
    readonly inviteId: string;
    readonly firmUserId: string;
    readonly passwordHash: string;
    readonly totpCiphertext: string;
    readonly totpNonce: string;
    readonly totpKeyVersion: number;
    /**
     * SHA-256 hashes of the recovery-code batch issued alongside
     * this acceptance. The raw values live only in the response the
     * caller is about to send; we persist the hashes so they can be
     * matched on the redemption endpoint without the DB ever seeing
     * a usable code.
     */
    readonly recoveryCodeHashes: readonly string[];
    readonly now: Date;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Burn the token first with a conditional update. If another
    // concurrent accept already flipped `used_at`, we get 0 rows and
    // bail before touching `firm_users`.
    const burn = await tx
      .update(firmUserInvites)
      .set({ usedAt: input.now })
      .where(and(eq(firmUserInvites.id, input.inviteId), isNull(firmUserInvites.usedAt)))
      .returning({ id: firmUserInvites.id });

    if (burn.length === 0) {
      return false;
    }

    await tx
      .update(firmUsers)
      .set({
        passwordHash: input.passwordHash,
        totpSecretCiphertext: input.totpCiphertext,
        totpSecretNonce: input.totpNonce,
        totpKeyVersion: input.totpKeyVersion,
        totpEnrolledAt: input.now,
        acceptedAt: input.now,
        passwordChangedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(firmUsers.id, input.firmUserId));

    if (input.recoveryCodeHashes.length > 0) {
      await tx.insert(firmUserRecoveryCodes).values(
        input.recoveryCodeHashes.map((hash) => ({
          firmUserId: input.firmUserId,
          codeHash: hash,
          createdAt: input.now,
        })),
      );
    }

    return true;
  });
}

/**
 * Update a firm (tier, limits, contact info).
 */
export async function updateFirmForAdmin(
  db: CrivacyDatabase,
  firmId: string,
  updates: {
    readonly name?: string | undefined;
    readonly tier?: string | undefined;
    readonly contactEmail?: string | undefined;
    readonly countryCode?: string | undefined;
    readonly notes?: string | undefined;
  },
): Promise<AdminFirmListItem | null> {
  const now = new Date();
  const setValues: Record<string, unknown> = { updatedAt: now };
  if (updates.name !== undefined) setValues['name'] = updates.name;
  if (updates.tier !== undefined) setValues['tier'] = updates.tier;
  if (updates.contactEmail !== undefined) setValues['contactEmail'] = updates.contactEmail;
  if (updates.countryCode !== undefined) setValues['countryCode'] = updates.countryCode;
  if (updates.notes !== undefined) setValues['notes'] = updates.notes;

  const result = await db
    .update(firms)
    .set(setValues as Partial<typeof firms.$inferInsert>)
    .where(eq(firms.id, firmId))
    .returning({
      id: firms.id,
      name: firms.name,
      slug: firms.slug,
      tier: firms.tier,
      contactEmail: firms.contactEmail,
      countryCode: firms.countryCode,
      createdAt: firms.createdAt,
      deletedAt: firms.deletedAt,
    });
  return result[0] ?? null;
}

/**
 * Soft-delete a firm + revoke every credential the firm owns.
 *
 * The middleware at `dashboard-route.ts` and `api-route.ts` checks
 * `firm.deletedAt !== null` and rejects those sessions/API keys at
 * auth time — but OAuth endpoints (`/api/v1/oauth/*`) look up
 * clients via `isNull(oauthClients.revokedAt)` and never join firms,
 * so a deleted firm's OAuth integration would keep operating on the
 * existing tokens. Equivalent concern for api_keys: we flip
 * revokedAt atomically with the firm soft-delete so
 * `findOauthClientByClientId` + API key auth both fail-closed.
 *
 * Hard delete would CASCADE via FK, but this is SOFT — cascade
 * doesn't fire, so we do the equivalent manually.
 */
export async function softDeleteFirmForAdmin(
  db: CrivacyDatabase,
  firmId: string,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(firms).set({ deletedAt: now }).where(eq(firms.id, firmId));
    // oauth_clients table only has `revoked_at` (no revoked_reason
     // column); the firm-delete reason is captured in the audit row
     // written by the caller, not in the client row.
    await tx
      .update(oauthClients)
      .set({ revokedAt: now })
      .where(and(eq(oauthClients.firmId, firmId), isNull(oauthClients.revokedAt)));
    await tx
      .update(apiKeys)
      .set({ revokedAt: now, revokedReason: 'firm_soft_deleted' })
      .where(and(eq(apiKeys.firmId, firmId), isNull(apiKeys.revokedAt)));
    // Revoke active firm_user sessions belonging to THIS firm only.
    // `sessions` table carries user_id + user_kind but not firm_id,
    // so filter via a subquery on `firm_users`.
    await tx.execute(sql`
      UPDATE sessions
         SET revoked_at = ${now.toISOString()},
             revoked_reason = 'firm_soft_deleted'
       WHERE user_kind = 'firm'
         AND revoked_at IS NULL
         AND user_id IN (SELECT id FROM firm_users WHERE firm_id = ${firmId})
    `);
  });
}

/**
 * Restore a soft-deleted firm.
 *
 * Runs inside a serialisable transaction so another admin can't race
 * through the "create a live firm with the old slug" window while we
 * check-then-flip. The conflict check has to live in application
 * code because the partial unique index (live rows only) can't stop
 * us from clearing `deleted_at` on its own — by the time the index
 * sees the row it's too late.
 *
 * Throws {@link AdminError} with:
 *   * `firm_not_found` — no row for this id.
 *   * `firm_already_active` — row exists but `deleted_at IS NULL`;
 *     callers probably double-submitted the restore action.
 *   * `firm_slug_taken` — another live firm grabbed the slug while
 *     this one was deactivated. Admin must rename one of them first.
 */
export async function restoreFirmForAdmin(db: CrivacyDatabase, firmId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ slug: firms.slug, deletedAt: firms.deletedAt })
      .from(firms)
      .where(eq(firms.id, firmId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new AdminError('firm_not_found', 'Firm not found.');
    }
    if (row.deletedAt === null) {
      throw new AdminError('firm_already_active', 'This firm is already active.');
    }

    const conflicts = await tx
      .select({ id: firms.id })
      .from(firms)
      .where(and(eq(firms.slug, row.slug), isNull(firms.deletedAt)))
      .limit(1);
    if (conflicts.length > 0) {
      throw new AdminError(
        'firm_slug_taken',
        `Another live firm is using the slug "${row.slug}". Rename or deactivate it before restoring this one.`,
      );
    }

    await tx.update(firms).set({ deletedAt: null }).where(eq(firms.id, firmId));
  });
}

/* ---------- Status components ---------- */

/** Status component row for admin. */
export interface AdminStatusComponentRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly groupName: string | null;
  readonly position: number;
  readonly currentState: string;
  readonly manualOverride: boolean;
  readonly manualOverrideReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * List all status components.
 */
export async function listStatusComponentsForAdmin(
  db: CrivacyDatabase,
): Promise<readonly AdminStatusComponentRow[]> {
  return db
    .select({
      id: statusComponents.id,
      slug: statusComponents.slug,
      name: statusComponents.name,
      description: statusComponents.description,
      groupName: statusComponents.groupName,
      position: statusComponents.position,
      currentState: statusComponents.currentState,
      manualOverride: statusComponents.manualOverride,
      manualOverrideReason: statusComponents.manualOverrideReason,
      createdAt: statusComponents.createdAt,
      updatedAt: statusComponents.updatedAt,
    })
    .from(statusComponents)
    .orderBy(asc(statusComponents.position));
}

/**
 * Create a status component.
 */
export async function createStatusComponent(
  db: CrivacyDatabase,
  input: {
    readonly slug: string;
    readonly name: string;
    readonly description?: string | undefined;
    readonly groupName?: string | undefined;
    readonly position?: number | undefined;
  },
): Promise<{ id: string }> {
  const result = await db
    .insert(statusComponents)
    .values({
      slug: input.slug,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.groupName !== undefined ? { groupName: input.groupName } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
    })
    .returning({ id: statusComponents.id });
  const row = result[0];
  if (row === undefined) throw new Error('Failed to create status component');
  return row;
}

/**
 * Update a status component state (manual override).
 */
export async function updateStatusComponentForAdmin(
  db: CrivacyDatabase,
  componentId: string,
  updates: {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly groupName?: string | undefined;
    readonly position?: number | undefined;
    readonly currentState?: string | undefined;
    readonly manualOverride?: boolean | undefined;
    readonly manualOverrideReason?: string | undefined;
  },
  adminUserId: string,
): Promise<AdminStatusComponentRow | null> {
  const now = new Date();
  const result = await db
    .update(statusComponents)
    .set({
      ...updates,
      updatedAt: now,
    } as Partial<typeof statusComponents.$inferInsert>)
    .where(eq(statusComponents.id, componentId))
    .returning({
      id: statusComponents.id,
      slug: statusComponents.slug,
      name: statusComponents.name,
      description: statusComponents.description,
      groupName: statusComponents.groupName,
      position: statusComponents.position,
      currentState: statusComponents.currentState,
      manualOverride: statusComponents.manualOverride,
      manualOverrideReason: statusComponents.manualOverrideReason,
      createdAt: statusComponents.createdAt,
      updatedAt: statusComponents.updatedAt,
    });

  const updated = result[0];
  if (updated === undefined) return null;

  // Record state change in history if currentState was updated
  if (updates.currentState !== undefined) {
    await db.insert(statusHistory).values({
      componentId,
      state: updates.currentState as typeof statusHistory.$inferInsert.state,
      source: 'manual',
      note: updates.manualOverrideReason ?? `Manual override by admin ${adminUserId}`,
    });
  }

  return updated;
}

/* ---------- Status incidents ---------- */

/** Status incident row for admin. */
export interface AdminStatusIncidentRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly status: string;
  readonly componentIds: string[];
  readonly updatesTimeline: unknown;
  readonly published: boolean;
  readonly startedAt: Date;
  readonly resolvedAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * List status incidents.
 */
export async function listStatusIncidentsForAdmin(
  db: CrivacyDatabase,
  opts: {
    readonly status?: string | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  } = {},
): Promise<{ incidents: readonly AdminStatusIncidentRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions = [];
  if (opts.status !== undefined) {
    conditions.push(
      eq(statusIncidents.status, opts.status as (typeof statusIncidents.status.enumValues)[number]),
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: statusIncidents.id,
      title: statusIncidents.title,
      body: statusIncidents.body,
      severity: statusIncidents.severity,
      status: statusIncidents.status,
      componentIds: statusIncidents.componentIds,
      updatesTimeline: statusIncidents.updatesTimeline,
      published: statusIncidents.published,
      startedAt: statusIncidents.startedAt,
      resolvedAt: statusIncidents.resolvedAt,
      createdBy: statusIncidents.createdBy,
      createdAt: statusIncidents.createdAt,
      updatedAt: statusIncidents.updatedAt,
    })
    .from(statusIncidents)
    .where(whereClause)
    .orderBy(desc(statusIncidents.startedAt))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(statusIncidents)
    .where(whereClause);
  const total = countResult[0]?.count ?? 0;

  return { incidents: rows, total };
}

/**
 * Create a status incident.
 */
export async function createStatusIncident(
  db: CrivacyDatabase,
  input: {
    readonly title: string;
    readonly body: string;
    readonly severity: string;
    readonly status?: string | undefined;
    readonly componentIds?: string[] | undefined;
    readonly published?: boolean | undefined;
    readonly createdBy: string;
  },
): Promise<{ id: string }> {
  const result = await db
    .insert(statusIncidents)
    .values({
      title: input.title,
      body: input.body,
      severity: input.severity as (typeof statusIncidents.severity.enumValues)[number],
      ...(input.status !== undefined
        ? { status: input.status as (typeof statusIncidents.status.enumValues)[number] }
        : {}),
      ...(input.componentIds !== undefined ? { componentIds: input.componentIds } : {}),
      ...(input.published !== undefined ? { published: input.published } : {}),
      createdBy: input.createdBy,
    })
    .returning({ id: statusIncidents.id });
  const row = result[0];
  if (row === undefined) throw new Error('Failed to create status incident');
  return row;
}

/**
 * Update a status incident (add update, change status, resolve).
 */
export async function updateStatusIncident(
  db: CrivacyDatabase,
  incidentId: string,
  updates: {
    readonly status?: string | undefined;
    readonly body?: string | undefined;
    readonly published?: boolean | undefined;
    readonly resolvedAt?: Date | undefined;
    readonly identifiedAt?: Date | undefined;
    readonly monitoringAt?: Date | undefined;
  },
): Promise<AdminStatusIncidentRow | null> {
  const now = new Date();
  const result = await db
    .update(statusIncidents)
    .set({
      ...updates,
      updatedAt: now,
    } as Partial<typeof statusIncidents.$inferInsert>)
    .where(eq(statusIncidents.id, incidentId))
    .returning({
      id: statusIncidents.id,
      title: statusIncidents.title,
      body: statusIncidents.body,
      severity: statusIncidents.severity,
      status: statusIncidents.status,
      componentIds: statusIncidents.componentIds,
      updatesTimeline: statusIncidents.updatesTimeline,
      published: statusIncidents.published,
      startedAt: statusIncidents.startedAt,
      resolvedAt: statusIncidents.resolvedAt,
      createdBy: statusIncidents.createdBy,
      createdAt: statusIncidents.createdAt,
      updatedAt: statusIncidents.updatedAt,
    });
  return result[0] ?? null;
}

/**
 * Add a timeline update to an incident (atomic JSONB append).
 */
export async function addIncidentTimelineUpdate(
  db: CrivacyDatabase,
  incidentId: string,
  update: {
    readonly at: string;
    readonly status: string;
    readonly body: string;
  },
): Promise<void> {
  await db
    .update(statusIncidents)
    .set({
      updatesTimeline: sql`${statusIncidents.updatesTimeline} || ${JSON.stringify([update])}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(statusIncidents.id, incidentId));
}

/* ---------- Global audit log (admin view) ---------- */

/** Audit entry for admin global view. */
export interface AdminAuditEntry {
  readonly id: number;
  readonly action: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly actorLabel: string | null;
  readonly firmId: string | null;
  readonly targetKind: string | null;
  readonly targetId: string | null;
  readonly targetRef: string | null;
  readonly meta: unknown;
  readonly ts: Date;
}

/**
 * List global audit entries (all firms).
 */
export async function listGlobalAuditEntries(
  db: CrivacyDatabase,
  opts: {
    readonly firmId?: string | undefined;
    readonly action?: string | undefined;
    readonly actorKind?: string | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  } = {},
): Promise<{ entries: readonly AdminAuditEntry[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;

  const conditions = [];
  if (opts.firmId !== undefined) {
    conditions.push(eq(auditLog.firmId, opts.firmId));
  }
  if (opts.action !== undefined) {
    conditions.push(eq(auditLog.action, opts.action));
  }
  if (opts.actorKind !== undefined) {
    conditions.push(
      eq(auditLog.actorKind, opts.actorKind as (typeof auditLog.actorKind.enumValues)[number]),
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorKind: auditLog.actorKind,
      actorId: auditLog.actorId,
      actorLabel: auditLog.actorLabel,
      firmId: auditLog.firmId,
      targetKind: auditLog.targetKind,
      targetId: auditLog.targetId,
      targetRef: auditLog.targetRef,
      meta: auditLog.meta,
      ts: auditLog.ts,
    })
    .from(auditLog)
    .where(whereClause)
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(whereClause);
  const total = countResult[0]?.count ?? 0;

  return {
    entries: rows.map((row) => ({
      ...row,
      meta: row.meta ?? null,
    })),
    total,
  };
}

/* ---------- System metrics ---------- */

/**
 * Get basic system metrics (counts).
 */
export async function getSystemMetrics(db: CrivacyDatabase): Promise<{
  totalFirms: number;
  activeFirms: number;
  totalSessions: number;
  activeSessions: number;
  totalAuditEntries: number;
  totalIncidents: number;
  activeIncidents: number;
}> {
  const now = sql`now()`;

  const [
    firmCount,
    activeFirmCount,
    dashboardSessionCount,
    activeDashboardSessionCount,
    customerSessionCount,
    activeCustomerSessionCount,
    auditCount,
    incidentCount,
    activeIncidentCount,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(firms),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(firms)
      .where(isNull(firms.deletedAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(sessions),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(isNull(sessions.revokedAt), sql`${sessions.expiresAt} > ${now}`)),
    db.select({ count: sql<number>`count(*)::int` }).from(customerSessions),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(customerSessions)
      .where(and(isNull(customerSessions.revokedAt), sql`${customerSessions.expiresAt} > ${now}`)),
    db.select({ count: sql<number>`count(*)::int` }).from(auditLog),
    db.select({ count: sql<number>`count(*)::int` }).from(statusIncidents),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(statusIncidents)
      .where(and(sql`${statusIncidents.status} != 'resolved'`)),
  ]);

  const totalSessions = (dashboardSessionCount[0]?.count ?? 0) + (customerSessionCount[0]?.count ?? 0);
  const activeSessions = (activeDashboardSessionCount[0]?.count ?? 0) + (activeCustomerSessionCount[0]?.count ?? 0);

  return {
    totalFirms: firmCount[0]?.count ?? 0,
    activeFirms: activeFirmCount[0]?.count ?? 0,
    totalSessions,
    activeSessions,
    totalAuditEntries: auditCount[0]?.count ?? 0,
    totalIncidents: incidentCount[0]?.count ?? 0,
    activeIncidents: activeIncidentCount[0]?.count ?? 0,
  };
}
