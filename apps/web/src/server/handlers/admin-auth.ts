/**
 * Admin authentication handlers — single-step login (firm-pattern parity), logout, refresh.
 *
 * Login flow (single request):
 *   email + password + Turnstile + optional totpCode →
 *     - TOTP not enrolled               → session cookies issued directly
 *     - TOTP enrolled + totpCode missing → 401 `totp_required` (UI reveals TOTP field)
 *     - TOTP enrolled + totpCode present → TOTP verified inline, session cookies issued
 *
 * This mirrors `handleLogin` in `dashboard-auth.ts` byte-for-byte at the
 * gating level: same `totp_not_enrolled` AuthError code, same
 * error-mapper translation to `totp_required` on the wire, same lockout
 * + tarpit + audit-row sequence. The pre-MP-A admin variant ran a
 * two-step flow with a 2-minute challenge token TTL that would expire
 * faster than a customer could read the code from their authenticator
 * app — that flow is gone.
 *
 * Security properties:
 *   - Turnstile verification at the route boundary (bot protection)
 *   - Rate limiting: 5 failed password attempts → 30 min account lock
 *   - TOTP: replay-protected via `verifyAndConsumeTotpCode` (BUG #54), wrong-code
 *     attempts share the password lockout counter so an attacker cannot rotate
 *     password ↔ TOTP keyspaces to dodge the lock
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { systemActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { emitSecurityEvent } from '@/lib/security-events';
import type { AuthConfig } from '@/lib/auth/config';
import { decryptTotpSecret } from '@/lib/auth/decrypt-totp';
import { getDummyPasswordHash } from '@/lib/auth/dummy-hash';
import { AuthError } from '@/lib/auth/errors';
import { assertAdminUserActiveFromRow } from '@/lib/admin/status-check';
import { verifyRefreshToken } from '@/lib/auth/jwt';
import {
  LOCKOUT_DURATION_MS,
  PROGRESSIVE_DELAY_THRESHOLD,
  getProgressiveDelayMs,
  sleep,
} from '@/lib/auth/lockout';
import { dispatchNewDeviceAlert } from '@/lib/auth/new-device-alert';
import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import { buildSession, rotateSession } from '@/lib/auth/sessions';
import { verifyAndConsumeTotpCode } from '@/lib/auth/totp';
import type { CrivacyDatabase } from '@/lib/db/client';
import { getRootLogger } from '@/lib/observability/logger';
import { recordAuthAttempt } from '@/lib/observability/request-metrics';

import type { AdminLoginUserRow } from '../repositories/admin';

/* ---------- Types ---------- */

/** Session row for admin refresh. */
export interface AdminRefreshSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly userKind: 'firm' | 'admin' | 'customer';
  readonly jwtJti: string;
  readonly refreshTokenHash: string;
  readonly refreshTokenVersion: number;
  readonly refreshExpiresAt: Date;
  readonly revokedAt: Date | null;
}

/** Dependencies injected into admin auth handlers. */
export interface AdminAuthHandlerDeps {
  readonly db: CrivacyDatabase;
  readonly authConfig: AuthConfig;
  readonly clock?: () => Date;
  readonly clientIp?: string | null;

  // Lookups
  readonly findAdminUserByEmail: (
    db: CrivacyDatabase,
    email: string,
  ) => Promise<AdminLoginUserRow | null>;
  readonly findSessionByJti: (
    db: CrivacyDatabase,
    jti: string,
  ) => Promise<AdminRefreshSessionRow | null>;

  // Mutations
  readonly insertSession: (
    db: CrivacyDatabase,
    record: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  readonly revokeSession: (
    db: CrivacyDatabase,
    sessionId: string,
    reason: string,
    now: Date,
  ) => Promise<void>;
  readonly revokeAllUserSessions: (
    db: CrivacyDatabase,
    userId: string,
    reason: string,
    now: Date,
  ) => Promise<void>;
  readonly updateSessionAfterRotate: (
    db: CrivacyDatabase,
    sessionId: string,
    updates: Record<string, unknown>,
  ) => Promise<void>;
  readonly findAdminUserById: (
    db: CrivacyDatabase,
    userId: string,
  ) => Promise<{ role: 'superadmin' | 'admin' | 'support' } | null>;
  /**
   * Atomic counter increment + conditional lock for admin users.
   * See `incrementAdminFailedLoginOrLock` in
   * `repositories/admin.ts` for the BUG #59 race rationale.
   */
  readonly incrementFailedLoginOrLock: (
    db: CrivacyDatabase,
    userId: string,
    maxAttempts: number,
    lockUntil: Date,
    now: Date,
  ) => Promise<{ failedLoginCount: number; justLocked: boolean }>;
  readonly resetFailedLogin: (
    db: CrivacyDatabase,
    userId: string,
    now: Date,
    ip: string | null,
  ) => Promise<void>;
}

/* ---------- Login (single-step, firm-pattern parity) ---------- */

const MAX_FAILED_ATTEMPTS = 5;

export interface AdminLoginInput {
  readonly email: string;
  readonly password: string;
  /**
   * Optional TOTP code. When the admin has TOTP enrolled, the first
   * request omits this field; the handler responds with the
   * `totp_not_enrolled` AuthError (mapped to wire code `totp_required`,
   * status 401) so the UI can reveal the second-factor input. The
   * follow-up request resends `email + password + totpCode` and the
   * handler verifies inline + issues the session — same single-form
   * shape `dashboard-auth.ts::handleLogin` uses.
   */
  readonly totpCode?: string;
}

export interface AdminLoginResult {
  /**
   * Always `false` on a successful response. The pre-MP-A two-step
   * variant returned a discriminated union (`totpRequired: true`
   * carrying a challenge token); the firm parity refactor folded
   * the TOTP gate into a single AuthError thrown when the code is
   * missing, so the success branch no longer needs the discriminator.
   * The field is kept on the wire for backwards-compat with the
   * existing route response shape.
   */
  readonly totpRequired: false;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: string;
  };
}

/**
 * Authenticate an admin user with email + password + optional TOTP.
 *
 * The caller (route) is responsible for Turnstile verification before
 * calling this. Single-step semantics match `handleLogin` in
 * `dashboard-auth.ts` — when TOTP is enrolled but no `totpCode` is
 * supplied, the handler throws `totp_not_enrolled` (mapped to
 * `totp_required` 401 by `error-mapper.ts`) so the UI can reveal a
 * second-factor input on the same form. The follow-up request
 * resends the credentials with the code; failed-TOTP attempts share
 * the password lockout counter so an attacker cannot rotate
 * password ↔ TOTP keyspaces to dodge the 5-attempt lock.
 */
export async function handleAdminLogin(
  deps: AdminAuthHandlerDeps,
  input: AdminLoginInput,
): Promise<AdminLoginResult> {
  const now = deps.clock?.() ?? new Date();
  const auditCtx = buildAuditContext({
    ip: deps.clientIp ?? null,
    userAgent: null,
  });

  // 1. Find admin user. Run a dummy argon2 verify on the unknown-
  //    email branch so the wall-clock profile matches the known-user
  //    path — absent this, a remote attacker can tell "admin email
  //    exists" from "doesn't" by timing alone.
  const user = await deps.findAdminUserByEmail(deps.db, input.email.toLowerCase().trim());
  if (user === null) {
    const dummyHash = await getDummyPasswordHash(deps.authConfig);
    await verifyPassword(input.password, dummyHash);
    recordAuthAttempt('password', 'failure');
    throw new AuthError('invalid_password', 'Invalid email or password.');
  }

  // Lock check used to live here and surfaced `account_locked`,
  // letting a random-password spray enumerate registered admin
  // emails. It now runs *after* password verification below — only
  // the caller who proves password knowledge reaches it, so a
  // legitimate owner sees the lock-window message while attackers
  // see only `invalid_password`.

  // 2. Verify password. The lock-trip path was already silent
  //    (throws `invalid_password`, not `account_locked`) so only the
  //    audit write is new here — attempts + lockouts now show up in
  //    the admin audit trail instead of being invisible.
  const passwordValid = await verifyPassword(input.password, user.passwordHash);
  if (!passwordValid) {
    recordAuthAttempt('password', 'failure');
    // BUG #59 fix: atomic increment + conditional lock. See the
    // firm-side handler for the race rationale; admin shares the
    // exact same SELECT-then-UPDATE bug shape.
    //
    // Path-B audit atomicity: the counter UPDATE and its audit row
    // share one tx so a writeAudit failure rolls back the increment
    // — login-fail attempts and their audit trail stay in lock-step
    // (NIST SP 800-92 §2.3.1).
    const lockUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
    let failedLoginCountForDelay = 0;
    let justLockedForDelay = false;
    await deps.db.transaction(async (tx) => {
      const { failedLoginCount, justLocked } = await deps.incrementFailedLoginOrLock(
        tx,
        user.id,
        MAX_FAILED_ATTEMPTS,
        lockUntil,
        now,
      );
      failedLoginCountForDelay = failedLoginCount;
      justLockedForDelay = justLocked;
      await writeAudit(tx, {
        action: 'admin_user.login.failed',
        actor: systemActor('admin-auth'),
        target: uuidTarget({ kind: 'admin_user', id: user.id }),
        context: auditCtx,
        meta: justLocked
          ? {
              reason: 'account_locked_now',
              failedAttempts: MAX_FAILED_ATTEMPTS,
              lockedUntil: lockUntil.toISOString(),
            }
          : { reason: 'invalid_password', failedAttempts: failedLoginCount },
        ts: now,
      });

      // F-XCC-AQ-LOCKOUT-NO-NOTIFY-003 — admin parity. Audit row is
      // the login.failed entry above; this event drives the email
      // leg only.
      if (justLocked) {
        await emitSecurityEvent({
          db: tx,
          eventType: 'admin_user.account_locked',
          subject: { kind: 'admin_user', id: user.id },
          payload: {
            auditContext: {
              ip: auditCtx.ip,
              userAgent: auditCtx.userAgent,
              requestId: auditCtx.requestId,
            },
            email: user.email,
            displayName: user.displayName,
            lockedUntil: lockUntil.toISOString(),
            reason: 'password',
          },
          now,
        });
      }
    });
    // F-XCC-AE Layer 2 (progressive delay / tarpit): mirror the firm
    // password-fail tarpit. On lock-trip the helper resets counter to
    // 0, so use MAX_FAILED_ATTEMPTS for the delay calc.
    await sleep(
      getProgressiveDelayMs(
        justLockedForDelay ? MAX_FAILED_ATTEMPTS : failedLoginCountForDelay,
      ),
    );
    throw new AuthError('invalid_password', 'Invalid email or password.');
  }

  recordAuthAttempt('password', 'success');

  // [POST-VERIFY LOCK CHECK]
  // Password has been proved correct; it is now safe to reveal the
  // real lock state because an unauthenticated attacker cannot
  // reach this line. Restores the UX where a legitimate admin
  // hitting a self-inflicted lockout sees the wait window instead
  // of a confusing `invalid_password` loop. F-A1-CROSS-PARITY-001
  // propagation — central `assertAdminUserActiveFromRow` is the
  // single-source lock invariant.
  try {
    assertAdminUserActiveFromRow(user, now);
  } catch (err) {
    if (err instanceof AuthError && err.code === 'account_locked') {
      await writeAudit(deps.db, {
        action: 'admin_user.login.failed',
        actor: systemActor('admin-auth'),
        target: uuidTarget({ kind: 'admin_user', id: user.id }),
        context: auditCtx,
        meta: {
          reason: 'account_locked',
          lockedUntil: user.lockedUntil!.toISOString(),
        },
        ts: now,
      });
    }
    throw err;
  }

  // Silent hash rotation — same pattern as the firm handler. Re-
  // hashes under current AuthConfig argon2id parameters on a
  // successful verify when the stored hash is weaker than policy.
  // Never blocks login on failure.
  if (needsRehash(user.passwordHash, deps.authConfig)) {
    try {
      const upgradedHash = await hashPassword(input.password, deps.authConfig);
      await deps.db.execute(
        sql`UPDATE admin_users SET password_hash = ${upgradedHash}, updated_at = ${now.toISOString()} WHERE id = ${user.id}`,
      );
    } catch (err) {
      getRootLogger().warn(
        {
          event: 'admin_login_hash_rotation_failed',
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        },
        'admin-login silent hash rotation failed',
      );
    }
  }

  // 4. Second-factor check (firm-pattern parity).
  //
  // When TOTP is enrolled and the request did not include a code,
  // throw `totp_not_enrolled` — `error-mapper.ts:81` translates it
  // to wire code `totp_required` with HTTP 401 so the UI reveals
  // the second-factor input inline (same SoT signal the firm
  // dashboard login page consumes).
  //
  // When TOTP is enrolled and a code WAS supplied, verify it
  // inline. A wrong code increments the same lockout counter as a
  // wrong password so attackers cannot rotate keyspaces. Replay
  // protection lives in `verifyAndConsumeTotpCode` (BUG #54 fix —
  // RFC 6238 §5.2 used-counter recording).
  const totpEnrolled =
    user.totpSecretCiphertext !== null &&
    user.totpSecretNonce !== null &&
    user.totpKeyVersion !== null &&
    user.totpEnrolledAt !== null;

  if (totpEnrolled) {
    const totpCode = input.totpCode;
    if (totpCode === undefined || totpCode.length === 0) {
      throw new AuthError('totp_not_enrolled', 'TOTP code is required.');
    }

    // Refined narrowing — `totpEnrolled` already guarantees these
    // are non-null, but the compiler doesn't carry that conjunction
    // through to this branch.
    const totpSecret = decryptTotpSecret(
      user.totpSecretCiphertext!,
      user.totpSecretNonce!,
      user.totpKeyVersion!,
      deps.authConfig.totpEncryptionKey,
    );

    const valid = await verifyAndConsumeTotpCode(
      deps.db,
      user.id,
      'admin',
      totpSecret,
      totpCode,
      deps.authConfig,
    );
    if (!valid) {
      // Wrong-code path shares the password lockout counter (firm
      // parity — see `dashboard-auth.ts::failSecondFactor`). Atomic
      // increment + conditional lock + audit row + tarpit, all
      // gated by the same MAX_FAILED_ATTEMPTS ceiling.
      const lockUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
      let failedLoginCountForDelay = 0;
      let justLockedForDelay = false;
      await deps.db.transaction(async (tx) => {
        const { failedLoginCount, justLocked } = await deps.incrementFailedLoginOrLock(
          tx,
          user.id,
          MAX_FAILED_ATTEMPTS,
          lockUntil,
          now,
        );
        failedLoginCountForDelay = failedLoginCount;
        justLockedForDelay = justLocked;
        await writeAudit(tx, {
          action: 'admin_user.login.failed',
          actor: systemActor('admin-auth'),
          target: uuidTarget({ kind: 'admin_user', id: user.id }),
          context: auditCtx,
          meta: justLocked
            ? {
                reason: 'totp_locked_now',
                failedAttempts: MAX_FAILED_ATTEMPTS,
                lockedUntil: lockUntil.toISOString(),
              }
            : { reason: 'invalid_totp_code', failedAttempts: failedLoginCount },
          ts: now,
        });
        if (justLocked) {
          await emitSecurityEvent({
            db: tx,
            eventType: 'admin_user.account_locked',
            subject: { kind: 'admin_user', id: user.id },
            payload: {
              auditContext: {
                ip: auditCtx.ip,
                userAgent: auditCtx.userAgent,
                requestId: auditCtx.requestId,
              },
              email: user.email,
              displayName: user.displayName,
              lockedUntil: lockUntil.toISOString(),
              reason: 'totp',
            },
            now,
          });
        }
      });
      await sleep(
        getProgressiveDelayMs(
          justLockedForDelay ? MAX_FAILED_ATTEMPTS : failedLoginCountForDelay,
        ),
      );
      if (justLockedForDelay) {
        throw new AuthError(
          'account_locked',
          'Account is temporarily locked due to too many failed TOTP attempts. Please try again later.',
        );
      }
      throw new AuthError('invalid_totp_code', 'Invalid authenticator code.');
    }
    // TOTP verified — fall through to the shared session-issue
    // block below.
  }

  // TOTP not enrolled OR successfully verified → issue session.
  const session = await buildSession(
    {
      kind: 'admin',
      userId: user.id,
      role: user.role,
      ip: deps.clientIp ?? null,
      userAgent: null,
    },
    deps.authConfig,
    now,
  );

  // New-device alert — probed BEFORE the session insert so the
  // probe is not polluted by the row we are about to create.
  await dispatchNewDeviceAlert({
    db: deps.db,
    audience: 'admin',
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    ip: deps.clientIp ?? null,
    userAgent: null,
    now,
    securityUrlPath: '/admin',
  });

  // Single session enforcement: revoke all existing sessions before creating a new one.
  // Race fix (BUG #50 admin side): wrap revoke + insert in a transaction
  // guarded by a per-admin advisory lock; serializes concurrent admin
  // logins so the same user can't end up with N parallel active
  // sessions when two POSTs land in the same millisecond. The migration
  // `20260427000000_session_active_unique.sql` adds the matching DB-side
  // partial unique index.
  await deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'admin_login:' + user.id}))`,
    );
    await deps.revokeAllUserSessions(tx, user.id, 'superseded_by_new_login', now);
    await deps.insertSession(tx, {
      id: randomUUID(),
      userId: session.record.userId,
      userKind: session.record.userKind,
      jwtJti: session.record.jwtJti,
      refreshTokenHash: session.record.refreshTokenHash,
      refreshTokenVersion: session.record.refreshTokenVersion,
      expiresAt: session.record.expiresAt,
      refreshExpiresAt: session.record.refreshExpiresAt,
      ip: session.record.ip,
      userAgent: session.record.userAgent,
    });
  });

  // F-XCC-AE Layer 2 (timing-oracle close): if pre-state counter
  // was already in tarpit zone, hold success response symmetrically.
  if (user.failedLoginCount >= PROGRESSIVE_DELAY_THRESHOLD) {
    await sleep(getProgressiveDelayMs(user.failedLoginCount));
  }

  await deps.resetFailedLogin(deps.db, user.id, now, deps.clientIp ?? null);

  // F-A1-J-AUTH-SUCCESS-001 — admin parity for login.success audit.
  // `totpUsed` reflects whether the inline second-factor branch
  // fired this request (was the customer enrolled AND did they
  // supply a code that verified). Pre-MP-A this was always false in
  // the step-1 audit row; the inline TOTP refactor folds the two
  // success paths into one row keyed by `totpUsed`.
  await writeAudit(deps.db, {
    action: 'admin_user.login.success',
    actor: systemActor('admin-auth'),
    target: uuidTarget({ kind: 'admin_user', id: user.id }),
    context: auditCtx,
    meta: { totpUsed: totpEnrolled },
    ts: now,
  });

  return {
    totpRequired: false,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.accessExpiresAt,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
  };
}

/* ---------- Logout ---------- */

/**
 * Revoke the current admin session.
 */
export async function handleAdminLogout(
  deps: Pick<AdminAuthHandlerDeps, 'db' | 'revokeSession' | 'findSessionByJti' | 'clock'>,
  jti: string,
): Promise<void> {
  const now = deps.clock?.() ?? new Date();
  const session = await deps.findSessionByJti(deps.db, jti);
  if (session === null) return;
  if (session.revokedAt !== null) return;
  await deps.revokeSession(deps.db, session.id, 'admin_logout', now);
}

/* ---------- Refresh ---------- */

export interface AdminRefreshInput {
  readonly refreshToken: string;
  readonly jti: string;
}

export interface AdminRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
}

/**
 * Rotate the refresh token and issue a new admin access token.
 */
export async function handleAdminRefresh(
  deps: Pick<
    AdminAuthHandlerDeps,
    | 'db'
    | 'authConfig'
    | 'clock'
    | 'findSessionByJti'
    | 'findAdminUserById'
    | 'revokeSession'
    | 'updateSessionAfterRotate'
  >,
  input: AdminRefreshInput,
): Promise<AdminRefreshResult> {
  const now = deps.clock?.() ?? new Date();

  const session = await deps.findSessionByJti(deps.db, input.jti);
  if (session === null) {
    throw new AuthError('invalid_refresh_token', 'Admin session not found.');
  }
  if (session.revokedAt !== null) {
    throw new AuthError('invalid_refresh_token', 'Admin session has been revoked.');
  }
  if (session.refreshExpiresAt < now) {
    throw new AuthError('invalid_refresh_token', 'Admin refresh token has expired.');
  }

  if (!verifyRefreshToken(input.refreshToken, session.refreshTokenHash)) {
    await deps.revokeSession(deps.db, session.id, 'refresh_token_mismatch', now);
    throw new AuthError('refresh_token_mismatch', 'Refresh token mismatch. Session revoked.');
  }

  // Look up the admin user's current role so the refreshed JWT is accurate
  const adminUser = await deps.findAdminUserById(deps.db, session.userId);
  const adminRole = adminUser?.role ?? 'admin';

  const rotated = await rotateSession(
    {
      userId: session.userId,
      kind: 'admin',
      role: adminRole,
      previousRefreshTokenVersion: session.refreshTokenVersion,
    },
    deps.authConfig,
    now,
  );

  await deps.updateSessionAfterRotate(deps.db, session.id, {
    jwtJti: rotated.record.jwtJti,
    refreshTokenHash: rotated.record.refreshTokenHash,
    refreshTokenVersion: rotated.record.refreshTokenVersion,
    expiresAt: rotated.record.expiresAt,
    refreshExpiresAt: rotated.record.refreshExpiresAt,
    lastSeenAt: now,
  });

  return {
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.accessExpiresAt,
  };
}
