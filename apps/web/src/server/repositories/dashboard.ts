/**
 * Dashboard repository — Drizzle queries for the internal API.
 *
 * Provides lookup/mutation functions that the dashboard handlers consume
 * via dependency injection. Each function takes `CrivacyDatabase` as its
 * first argument so the same function can be used within or outside a
 * transaction.
 *
 * @module
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { FirmTier } from '@crivacy/shared-types';

import { FAILED_LOGIN_DECAY_SECONDS } from '@/lib/auth/lockout';
import type { CrivacyDatabase } from '@/lib/db/client';
import {
  apiKeys,
  auditLog,
  firmSettings,
  firmUsers,
  firms,
  sessions,
  webhookDeliveries,
  webhookEndpoints,
} from '@/lib/db/schema';
import type { webhookDeliveryStatusEnum } from '@/lib/db/schema/enums';

import type { DashboardContext } from '../context';
import type { AuditListItem } from '../handlers/dashboard-audit';
import { redactMeta } from '@/lib/audit';
import type { LoginFirmRow, LoginUserRow, RefreshSessionRow } from '../handlers/dashboard-auth';
import type { FirmProfileRow, FirmSettingsRow } from '../handlers/dashboard-firm';
import type { ApiKeyListItem } from '../handlers/dashboard-keys';
import type { DeliveryListItem } from '../handlers/dashboard-webhooks';
import type { SessionRow } from '../middleware/dashboard-route';

/* ---------- Auth lookups ---------- */

/**
 * Find a firm user by email (case-insensitive).
 *
 * Narrowed to login-eligible rows only:
 *   - `accepted_at IS NOT NULL` — the invite flow was completed.
 *   - `password_hash IS NOT NULL` — a password was actually set.
 *   - `locked_at IS NULL` — the row hasn't been offboarded.
 *
 * Why the filter: a single email may have multiple `firm_users`
 * rows when the address was invited to more than one firm (the
 * unique index is `(firm_id, lower(email))`, not on email alone).
 * A raw `LIMIT 1` without filter or order would occasionally
 * return a PENDING INVITATION STUB (null password_hash) and the
 * login handler would immediately 401 with
 * "invalid email or password" — the same surface bug the end user
 * hits when trying to sign in after completing their invite, but
 * an older invitation for the same address is still lingering.
 *
 * The `locked_at IS NULL` clause closes the multi-firm offboard
 * bypass primitive (F-A7-MULTIFIRM-L13-001): without it, a locked
 * row was still resolved and the login handler minted a fresh
 * access token before the middleware kicked in on the very next
 * request. Excluding locked rows here means a user who has been
 * removed from one firm transparently falls through to their
 * still-active membership in another firm, instead of getting a
 * one-request bypass window.
 *
 * `ORDER BY accepted_at DESC` picks the most recently onboarded
 * row. The long-term fix for the "one email in multiple firms"
 * ambiguity is a firm picker on login, but until then this
 * ordering gives deterministic, least-surprising behaviour. The
 * forgot-password flow (`requestFirmUserPasswordReset`) MUST
 * mirror this exact policy or the reset email keys to a different
 * row than the one login resolves — see F-A7-MULTIFIRM-L4-001.
 */
export async function findUserByEmail(
  db: CrivacyDatabase,
  email: string,
): Promise<LoginUserRow | null> {
  const rows = await db
    .select()
    .from(firmUsers)
    .where(
      sql`lower(${firmUsers.email}) = ${email.toLowerCase()}
          AND ${firmUsers.acceptedAt} IS NOT NULL
          AND ${firmUsers.passwordHash} IS NOT NULL
          AND ${firmUsers.lockedAt} IS NULL`,
    )
    .orderBy(sql`${firmUsers.acceptedAt} DESC`)
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    firmId: row.firmId,
    email: row.email,
    role: row.role,
    passwordHash: row.passwordHash,
    totpSecretCiphertext: row.totpSecretCiphertext,
    totpSecretNonce: row.totpSecretNonce,
    totpKeyVersion: row.totpKeyVersion,
    totpEnrolledAt: row.totpEnrolledAt,
    lockedAt: row.lockedAt,
    lockedUntil: row.lockedUntil,
    failedLoginCount: row.failedLoginCount,
  };
}

/**
 * Find a firm user by ID.
 */
export async function findUserById(
  db: CrivacyDatabase,
  userId: string,
): Promise<LoginUserRow | null> {
  const rows = await db.select().from(firmUsers).where(eq(firmUsers.id, userId)).limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    firmId: row.firmId,
    email: row.email,
    role: row.role,
    passwordHash: row.passwordHash,
    totpSecretCiphertext: row.totpSecretCiphertext,
    totpSecretNonce: row.totpSecretNonce,
    totpKeyVersion: row.totpKeyVersion,
    totpEnrolledAt: row.totpEnrolledAt,
    lockedAt: row.lockedAt,
    lockedUntil: row.lockedUntil,
    failedLoginCount: row.failedLoginCount,
  };
}

/**
 * Find a firm by ID (for login).
 */
export async function findFirmById(
  db: CrivacyDatabase,
  firmId: string,
): Promise<LoginFirmRow | null> {
  const rows = await db
    .select({
      id: firms.id,
      name: firms.name,
      slug: firms.slug,
      tier: firms.tier,
      deletedAt: firms.deletedAt,
    })
    .from(firms)
    .where(eq(firms.id, firmId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return row;
}

/**
 * Find a session by JWT jti claim.
 */
export async function findSessionByJti(
  db: CrivacyDatabase,
  jti: string,
): Promise<RefreshSessionRow | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.jwtJti, jti)).limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    userId: row.userId,
    userKind: row.userKind,
    jwtJti: row.jwtJti,
    refreshTokenHash: row.refreshTokenHash,
    refreshTokenVersion: row.refreshTokenVersion,
    refreshExpiresAt: row.refreshExpiresAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Find a session by jti (for middleware).
 */
export async function findSessionByJtiForMiddleware(
  db: CrivacyDatabase,
  jti: string,
): Promise<SessionRow | null> {
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
  const row = rows[0];
  if (row === undefined) return null;
  return row;
}

/**
 * Find a firm user by ID (for middleware).
 */
export async function findFirmUserByIdForMiddleware(
  db: CrivacyDatabase,
  userId: string,
): Promise<{
  id: string;
  firmId: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  lockedAt: Date | null;
} | null> {
  const rows = await db
    .select({
      id: firmUsers.id,
      firmId: firmUsers.firmId,
      email: firmUsers.email,
      role: firmUsers.role,
      lockedAt: firmUsers.lockedAt,
    })
    .from(firmUsers)
    .where(eq(firmUsers.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Find a firm by ID (for middleware).
 */
export async function findFirmByIdForMiddleware(
  db: CrivacyDatabase,
  firmId: string,
): Promise<{
  id: string;
  slug: string;
  displayName: string;
  tier: FirmTier;
  deletedAt: Date | null;
} | null> {
  const rows = await db
    .select({
      id: firms.id,
      slug: firms.slug,
      displayName: firms.name,
      tier: firms.tier,
      deletedAt: firms.deletedAt,
    })
    .from(firms)
    .where(eq(firms.id, firmId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return { ...row, tier: row.tier as FirmTier };
}

/* ---------- Auth mutations ---------- */

/**
 * Insert a session row.
 */
export async function insertSession(
  db: CrivacyDatabase,
  record: Record<string, unknown>,
): Promise<{ id: string }> {
  const result = await db
    .insert(sessions)
    .values(record as typeof sessions.$inferInsert)
    .returning({ id: sessions.id });
  const row = result[0];
  if (row === undefined) throw new Error('Failed to insert session');
  return row;
}

/**
 * Revoke a session.
 */
export async function revokeSession(
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
 * Revoke ALL non-revoked sessions for a given firm user (single session enforcement).
 * Called before inserting a new session on login.
 */
export async function revokeAllDashboardSessions(
  db: CrivacyDatabase,
  userId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.userId, userId), eq(sessions.userKind, 'firm'), isNull(sessions.revokedAt)));
}

/**
 * Update a session row after refresh token rotation.
 */
export async function updateSessionAfterRotate(
  db: CrivacyDatabase,
  sessionId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  await db
    .update(sessions)
    .set(updates as Partial<typeof sessions.$inferInsert>)
    .where(eq(sessions.id, sessionId));
}

/**
 * Atomically increment the failed-login counter and trip the lock
 * if and only if this commit pushes the counter past the threshold.
 *
 * BUG #59 fix: the previous "SELECT counter, decide in handler,
 * UPDATE counter" pattern lost increments under parallel wrong-pwd
 * traffic — N racing requests all read the same prior counter
 * value, so the lockout threshold was never reached. Reading
 * `failed_login_count` inside the SET expression serializes on the
 * row-level lock PostgreSQL takes for every UPDATE, so each commit
 * observes the prior commit's increment.
 *
 * F-XCC-AE Layer 1 (sliding-window decay): each branch checks
 * `failed_login_first_at` against `FAILED_LOGIN_DECAY_SECONDS`. If
 * the earliest wrong-pwd of the current run is older than the
 * decay window (or NULL — first attempt ever) the counter resets
 * to 1 and `failed_login_first_at` is stamped fresh; otherwise the
 * counter accumulates and the threshold-cross check applies. On a
 * lock-trip we reset both `failed_login_count = 0` (legacy semantic
 * — `justLocked` flag still derived from `count === 0`) and
 * `failed_login_first_at = NULL` so the post-unlock cycle starts
 * clean.
 *
 * Returns the post-update counter and a `justLocked` flag for the
 * caller to pick the audit reason. `justLocked` is true exactly
 * once per lock cycle.
 */
export async function incrementFailedLoginOrLock(
  db: CrivacyDatabase,
  userId: string,
  maxAttempts: number,
  lockUntil: Date,
  now: Date,
): Promise<{ failedLoginCount: number; justLocked: boolean }> {
  const nowIso = now.toISOString();
  const lockUntilIso = lockUntil.toISOString();
  // Repeated SQL fragments — declared once, reused by each CASE so
  // the decay/trip predicate is the single-source semantic.
  const decayed = sql`(failed_login_first_at IS NULL OR EXTRACT(EPOCH FROM (${nowIso}::timestamptz - failed_login_first_at)) > ${FAILED_LOGIN_DECAY_SECONDS})`;
  const lockTrips = sql`(NOT ${decayed} AND failed_login_count + 1 >= ${maxAttempts} AND (locked_until IS NULL OR locked_until <= ${nowIso}::timestamptz))`;
  const result = await db.execute<{ failed_login_count: number }>(
    sql`UPDATE firm_users
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
 * Reset the failed login count and update last login time.
 *
 * F-XCC-AE Layer 1: also clears `failed_login_first_at` so the next
 * post-success wrong-pwd starts a fresh accumulating run rather
 * than inheriting a stale window.
 */
export async function resetFailedLogin(
  db: CrivacyDatabase,
  userId: string,
  now: Date,
): Promise<void> {
  await db
    .update(firmUsers)
    .set({
      failedLoginCount: 0,
      failedLoginFirstAt: null,
      lastLoginAt: now,
      lockedAt: null,
      lockedUntil: null,
    })
    .where(eq(firmUsers.id, userId));
}

/**
 * Save a TOTP secret (encrypted) for a firm user.
 */
export async function saveTotpSecret(
  db: CrivacyDatabase,
  userId: string,
  ciphertext: string,
  nonce: string,
  keyVersion: number,
  now: Date,
): Promise<void> {
  await db
    .update(firmUsers)
    .set({
      totpSecretCiphertext: ciphertext,
      totpSecretNonce: nonce,
      totpKeyVersion: keyVersion,
      totpEnrolledAt: now,
      updatedAt: now,
    })
    .where(eq(firmUsers.id, userId));
}

/* ---------- Firm profile ---------- */

/**
 * Get firm profile.
 */
export async function findFirmProfile(ctx: DashboardContext): Promise<FirmProfileRow | null> {
  const rows = await ctx.db
    .select({
      id: firms.id,
      name: firms.name,
      slug: firms.slug,
      tier: firms.tier,
      contactEmail: firms.contactEmail,
      countryCode: firms.countryCode,
      billingEmail: firms.billingEmail,
      supportUrl: firms.supportUrl,
      createdAt: firms.createdAt,
    })
    .from(firms)
    .where(eq(firms.id, ctx.firm.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Get firm settings.
 */
export async function findFirmSettings(ctx: DashboardContext): Promise<FirmSettingsRow | null> {
  const rows = await ctx.db
    .select({
      totpRequired: firmSettings.totpRequired,
      dataRetentionDays: firmSettings.dataRetentionDays,
      ipAllowlist: firmSettings.ipAllowlist,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, ctx.firm.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Update firm profile fields.
 */
export async function updateFirm(
  ctx: DashboardContext,
  updates: {
    readonly name?: string;
    readonly contactEmail?: string;
    readonly billingEmail?: string;
    readonly supportUrl?: string;
  },
): Promise<FirmProfileRow> {
  const now = new Date();
  const result = await ctx.db
    .update(firms)
    .set({ ...updates, updatedAt: now } as Partial<typeof firms.$inferInsert>)
    .where(eq(firms.id, ctx.firm.id))
    .returning({
      id: firms.id,
      name: firms.name,
      slug: firms.slug,
      tier: firms.tier,
      contactEmail: firms.contactEmail,
      countryCode: firms.countryCode,
      billingEmail: firms.billingEmail,
      supportUrl: firms.supportUrl,
      createdAt: firms.createdAt,
    });
  const row = result[0];
  if (row === undefined) throw new Error('Firm update returned no rows');
  return row;
}

/* ---------- On-chain wallet ---------- */

/** Read the firm's registered on-chain (EVM) address, or null if unset. */
export async function getFirmOnchainAddress(ctx: DashboardContext): Promise<string | null> {
  const rows = await ctx.db
    .select({ onchainAddress: firms.onchainAddress })
    .from(firms)
    .where(eq(firms.id, ctx.firm.id))
    .limit(1);
  return rows[0]?.onchainAddress ?? null;
}

/**
 * Set (or clear, when `address` is null) the firm's on-chain address. The
 * caller must have proven control of `address` via a SIWE signature first.
 * Stored lowercase so on-chain comparisons are stable.
 */
export async function setFirmOnchainAddress(
  ctx: DashboardContext,
  address: string | null,
): Promise<void> {
  await ctx.db
    .update(firms)
    .set({ onchainAddress: address === null ? null : address.toLowerCase(), updatedAt: new Date() })
    .where(eq(firms.id, ctx.firm.id));
}

/* ---------- API keys ---------- */

/**
 * Count active (non-revoked) API keys for a firm. Used by the tier
 * cap enforcement in the create handler — only non-revoked rows
 * count so a firm that rotates keys doesn't hit the ceiling
 * mid-rotation. Revoked keys remain in the table for audit history
 * but don't consume a slot.
 */
export async function countActiveApiKeysByFirm(
  db: CrivacyDatabase,
  firmId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apiKeys)
    .where(and(eq(apiKeys.firmId, firmId), isNull(apiKeys.revokedAt)));
  return rows[0]?.count ?? 0;
}

/**
 * List API keys for a firm.
 */
export async function listApiKeys(ctx: DashboardContext): Promise<readonly ApiKeyListItem[]> {
  const rows = await ctx.db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      mode: apiKeys.mode,
      scopes: apiKeys.scopes,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.firmId, ctx.firm.id))
    .orderBy(desc(apiKeys.createdAt));
  return rows;
}

/**
 * Insert a new API key.
 */
export async function insertApiKey(
  db: CrivacyDatabase,
  firmId: string,
  row: {
    readonly name: string;
    readonly prefix: string;
    readonly hash: string;
    readonly mode: 'live' | 'test';
    readonly scopes: readonly string[];
    readonly expiresAt: Date | null;
  },
): Promise<{ id: string; createdAt: Date }> {
  const result = await db
    .insert(apiKeys)
    .values({
      firmId,
      prefix: row.prefix,
      hash: row.hash,
      name: row.name,
      scopes: [...row.scopes],
      mode: row.mode,
      ...(row.expiresAt !== null ? { expiresAt: row.expiresAt } : {}),
    })
    .returning({ id: apiKeys.id, createdAt: apiKeys.createdAt });
  const inserted = result[0];
  if (inserted === undefined) throw new Error('Failed to insert API key');
  return inserted;
}

/**
 * Revoke an API key. Returns `true` when a row was actually flipped,
 * `false` when the (id, firmId) tuple did not match any row — caller
 * surfaces that as 404 instead of a misleading 204. Without this guard
 * the endpoint silently succeeds on cross-firm or non-existent UUIDs,
 * which is the BUG #43 endpoint-contract bug surfaced by the IDOR
 * sweep on 2026-04-25.
 */
export async function revokeApiKey(
  db: CrivacyDatabase,
  firmId: string,
  keyId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: now, revokedReason: 'user_revoked' })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.firmId, firmId)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/**
 * Fetch the creator ID of an API key within a firm. Returns `null`
 * when the key does not exist (firm-scoped lookup — cross-firm IDs
 * are indistinguishable from missing keys, same as the mutation
 * repositories). Consumed by route handlers that do `.own` vs `.any`
 * ownership gating above the mutation layer.
 */
export async function findApiKeyCreatorId(
  db: CrivacyDatabase,
  firmId: string,
  keyId: string,
): Promise<string | null> {
  const rows = await db
    .select({ createdByUserId: apiKeys.createdByUserId })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.firmId, firmId)))
    .limit(1);
  return rows[0]?.createdByUserId ?? null;
}

/**
 * Rotate an API key (update prefix + hash). Returns `true` when a row
 * was actually rotated, `false` when the (id, firmId) tuple matched no
 * row. Same BUG #43 contract fix as `revokeApiKey` — without this the
 * handler returns a freshly-minted rawKey for a non-existent or
 * cross-firm UUID, leaking nothing real but lying to the caller.
 */
export async function rotateApiKey(
  db: CrivacyDatabase,
  firmId: string,
  keyId: string,
  newPrefix: string,
  newHash: string,
  _now: Date,
): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ prefix: newPrefix, hash: newHash })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.firmId, firmId)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/* ---------- Usage ---------- */

// Usage chart data is served by the existing usage repository.
// Step 12 dashboard routes consume `getUsageForPeriod` from `./usage.ts`.

/* ---------- Webhook deliveries ---------- */

/**
 * List webhook deliveries for a firm.
 */
export async function listDashboardDeliveries(
  ctx: DashboardContext,
  opts: {
    readonly endpointId?: string;
    readonly status?: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
): Promise<{
  deliveries: readonly DeliveryListItem[];
  total: number;
  hasMore: boolean;
  cursor: string | null;
}> {
  const limit = Math.min(opts.limit ?? 50, 100);

  // AUD-INT-AUTHZ-IDOR-001 fix: scope deliveries to the caller's
  // firm via a JOIN against `webhook_endpoints`. The prior query had
  // no WHERE clause — every firm's dashboard returned every other
  // firm's delivery rows. Honouring the `endpointId` + `status`
  // opts that were already declared on the interface also lands
  // here (they were silently ignored before).
  const conditions = [eq(webhookEndpoints.firmId, ctx.firm.id)];
  if (opts.endpointId !== undefined) {
    conditions.push(eq(webhookDeliveries.endpointId, opts.endpointId));
  }
  if (opts.status !== undefined) {
    conditions.push(
      eq(
        webhookDeliveries.status,
        opts.status as (typeof webhookDeliveryStatusEnum)['enumValues'][number],
      ),
    );
  }

  const rows = await ctx.db
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      eventId: webhookDeliveries.eventId,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      maxAttempts: webhookDeliveries.maxAttempts,
      httpStatus: webhookDeliveries.lastHttpStatus,
      error: webhookDeliveries.lastError,
      createdAt: webhookDeliveries.createdAt,
      deliveredAt: webhookDeliveries.deliveredAt,
      nextRetryAt: webhookDeliveries.nextRetryAt,
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookDeliveries.endpointId, webhookEndpoints.id),
    )
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const deliveries = rows.slice(0, limit).map((r) => ({
    ...r,
    eventType: 'unknown', // joined from webhook_events in a real query
  }));

  return {
    deliveries,
    total: deliveries.length,
    hasMore,
    cursor: null,
  };
}

/**
 * Replay a failed delivery by resetting its status. Firm-scoped —
 * the UPDATE only touches a row whose `endpoint_id` belongs to the
 * caller's firm. `null` return lets the handler translate "not my
 * firm / not found" into a uniform 404 without leaking which branch
 * was hit.
 */
export async function replayDelivery(
  ctx: DashboardContext,
  deliveryId: string,
): Promise<{ id: string } | null> {
  // AUD-INT-AUTHZ-IDOR-001 fix: the UPDATE previously matched any
  // delivery by id, so any firm member with `webhook.delivery.replay`
  // could resubmit ANOTHER firm's delivery to that firm's endpoint
  // (cross-firm write primitive). Scoping via the endpoint-owned-
  // by-firm subquery closes the gap; `.returning()` + null gives
  // the caller a not-found signal in one round-trip.
  const result = await ctx.db
    .update(webhookDeliveries)
    .set({ status: 'pending', attempts: 0 })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        inArray(
          webhookDeliveries.endpointId,
          ctx.db
            .select({ id: webhookEndpoints.id })
            .from(webhookEndpoints)
            .where(eq(webhookEndpoints.firmId, ctx.firm.id)),
        ),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  if (result.length === 0) return null;
  return { id: deliveryId };
}

/* ---------- Audit log ---------- */

/**
 * List audit entries for a firm.
 */
export async function listAuditEntries(
  ctx: DashboardContext,
  opts: {
    readonly action?: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
): Promise<{
  entries: readonly AuditListItem[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const limit = Math.min(opts.limit ?? 50, 500);

  const conditions = [eq(auditLog.firmId, ctx.firm.id)];
  if (opts.action !== undefined) {
    conditions.push(eq(auditLog.action, opts.action));
  }

  const rows = await ctx.db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorKind: auditLog.actorKind,
      actorId: auditLog.actorId,
      actorLabel: auditLog.actorLabel,
      targetKind: auditLog.targetKind,
      targetId: auditLog.targetId,
      targetRef: auditLog.targetRef,
      ip: auditLog.ip,
      userAgent: auditLog.userAgent,
      requestId: auditLog.requestId,
      meta: auditLog.meta,
      ts: auditLog.ts,
    })
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  // PII redaction for firm audience — customer email/phone/address
  // appear in meta of customer.*-action rows (e.g. `firm_user.invited`
  // with the invitee's email). The firm viewer sees these trimmed per
  // the `firm` audience rules (email truncated, phone redacted, etc.)
  // while admin/compliance audiences keep full values. AUD-X-COMP-003.
  const entries = rows.slice(0, limit).map((row) => {
    const rawMeta = (row.meta as Record<string, unknown> | null) ?? null;
    return {
      ...row,
      meta: rawMeta === null ? null : redactMeta(rawMeta, { audience: 'firm' }),
    };
  });

  return {
    entries,
    hasMore,
    nextCursor: null,
  };
}

/* ---------- Playground ---------- */

/**
 * Look up an active API key by ID + firm for playground usage.
 * Returns null if the key doesn't exist, is revoked, or doesn't belong to the firm.
 */
export async function findApiKeyForPlayground(
  db: CrivacyDatabase,
  keyId: string,
  firmId: string,
): Promise<{ id: string; prefix: string; keyHash: string; mode: string } | null> {
  const rows = await db
    .select({
      id: apiKeys.id,
      prefix: apiKeys.prefix,
      keyHash: apiKeys.hash,
      mode: apiKeys.mode,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.firmId, firmId), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  if (row === undefined) return null;
  return row;
}

/**
 * Resolve an API key + its firm by key id **without** bcrypt. Used
 * exclusively by the playground-token path in `apiRoute` — the
 * middleware has already verified a signed token that names this
 * exact key, so the normal raw-key → prefix → bcrypt flow would
 * duplicate work we can't perform (the dashboard doesn't have the
 * plaintext).
 *
 * Returns `null` when the key is revoked, expired, or missing. The
 * firm is also returned so the middleware's soft-delete check can
 * reject requests against a deactivated firm even through the
 * playground surface.
 */
export async function resolveApiKeyByIdForPlayground(
  db: CrivacyDatabase,
  keyId: string,
  firmId: string,
  now: Date,
): Promise<{
  apiKey: {
    id: string;
    firmId: string;
    prefix: string;
    name: string;
    scopes: readonly string[];
    mode: string;
  };
  firm: {
    id: string;
    slug: string;
    displayName: string;
    tier: string;
    deletedAt: Date | null;
  };
} | null> {
  const rows = await db
    .select({
      keyId: apiKeys.id,
      keyFirmId: apiKeys.firmId,
      prefix: apiKeys.prefix,
      name: apiKeys.name,
      scopes: apiKeys.scopes,
      mode: apiKeys.mode,
      expiresAt: apiKeys.expiresAt,
      firmId: firms.id,
      firmSlug: firms.slug,
      firmName: firms.name,
      firmTier: firms.tier,
      firmDeletedAt: firms.deletedAt,
    })
    .from(apiKeys)
    .innerJoin(firms, eq(firms.id, apiKeys.firmId))
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.firmId, firmId), isNull(apiKeys.revokedAt)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  if (row.expiresAt !== null && row.expiresAt <= now) return null;

  return {
    apiKey: {
      id: row.keyId,
      firmId: row.keyFirmId,
      prefix: row.prefix,
      name: row.name,
      scopes: row.scopes,
      mode: row.mode,
    },
    firm: {
      id: row.firmId,
      slug: row.firmSlug,
      displayName: row.firmName,
      tier: row.firmTier,
      deletedAt: row.firmDeletedAt,
    },
  };
}
