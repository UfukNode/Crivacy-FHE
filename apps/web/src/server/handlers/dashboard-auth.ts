/**
 * Dashboard authentication handlers — login, logout, refresh, TOTP.
 *
 * These handlers are framework-free functions that receive injected
 * dependencies. The route files in `src/app/api/internal/auth/`
 * wire them up with actual DB lookups and config.
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
import { loadKeyFromBase64, seal } from '@/lib/auth/crypto-box';
import { decryptTotpSecret } from '@/lib/auth/decrypt-totp';
import { getDummyPasswordHash } from '@/lib/auth/dummy-hash';
import { AuthError } from '@/lib/auth/errors';
import {
  assertFirmActive,
  assertFirmUserActiveFromRow,
} from '@/lib/firm/status-check';
import { verifyRefreshToken } from '@/lib/auth/jwt';
import {
  LOCKOUT_DURATION_MS,
  PROGRESSIVE_DELAY_THRESHOLD,
  getProgressiveDelayMs,
  sleep,
} from '@/lib/auth/lockout';
import { dispatchNewDeviceAlert } from '@/lib/auth/new-device-alert';
import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import { hashRecoveryCode } from '@/lib/auth/recovery-code';
import { buildSession, rotateSession } from '@/lib/auth/sessions';
import {
  buildOtpauthUrl,
  generateTotpSecret,
  verifyAndConsumeTotpCode,
  verifyTotpCode,
} from '@/lib/auth/totp';
import type { CrivacyDatabase } from '@/lib/db/client';
import { getRootLogger } from '@/lib/observability/logger';
import { recordAuthAttempt } from '@/lib/observability/request-metrics';

/* ---------- Types ---------- */

/** Minimal firm user row for login. */
export interface LoginUserRow {
  readonly id: string;
  readonly firmId: string;
  readonly email: string;
  readonly role: 'owner' | 'admin' | 'member' | 'viewer';
  readonly passwordHash: string | null;
  readonly totpSecretCiphertext: string | null;
  readonly totpSecretNonce: string | null;
  readonly totpKeyVersion: number | null;
  readonly totpEnrolledAt: Date | null;
  readonly lockedAt: Date | null;
  readonly lockedUntil: Date | null;
  readonly failedLoginCount: number;
}

/** Minimal firm row for login. */
export interface LoginFirmRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly tier: string;
  readonly deletedAt: Date | null;
}

/** Session row for refresh. */
export interface RefreshSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly userKind: 'firm' | 'admin' | 'customer';
  readonly jwtJti: string;
  readonly refreshTokenHash: string;
  readonly refreshTokenVersion: number;
  readonly refreshExpiresAt: Date;
  readonly revokedAt: Date | null;
}

/** Dependencies injected into auth handlers. */
export interface AuthHandlerDeps {
  readonly db: CrivacyDatabase;
  readonly authConfig: AuthConfig;
  readonly clock?: () => Date;

  // Lookups
  readonly findUserByEmail: (db: CrivacyDatabase, email: string) => Promise<LoginUserRow | null>;
  readonly findUserById: (db: CrivacyDatabase, userId: string) => Promise<LoginUserRow | null>;
  readonly findFirmById: (db: CrivacyDatabase, firmId: string) => Promise<LoginFirmRow | null>;
  readonly findSessionByJti: (
    db: CrivacyDatabase,
    jti: string,
  ) => Promise<RefreshSessionRow | null>;

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
  /**
   * Atomic counter increment + conditional lock. Returns
   * `{ failedLoginCount, justLocked }` so the handler can pick the
   * audit reason. See `incrementFailedLoginOrLock` in
   * `repositories/dashboard.ts` for the BUG #59 race rationale.
   */
  readonly incrementFailedLoginOrLock: (
    db: CrivacyDatabase,
    userId: string,
    maxAttempts: number,
    lockUntil: Date,
    now: Date,
  ) => Promise<{ failedLoginCount: number; justLocked: boolean }>;
  readonly resetFailedLogin: (db: CrivacyDatabase, userId: string, now: Date) => Promise<void>;
  readonly saveTotpSecret: (
    db: CrivacyDatabase,
    userId: string,
    ciphertext: string,
    nonce: string,
    keyVersion: number,
    now: Date,
  ) => Promise<void>;
}

/* ---------- Login ---------- */

const MAX_FAILED_ATTEMPTS = 5;

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly totpCode?: string;
  /**
   * Recovery code (dashed `XXXXX-XXXXX`). When supplied *instead of*
   * `totpCode`, the second-factor check redeems the code from
   * `firm_user_recovery_codes` rather than verifying a TOTP. Both
   * paths share the same per-user attempt counter so a mix-and-match
   * brute-force attempt still hits the same lockout.
   */
  readonly recoveryCode?: string;
  /** Client IP for the login audit trail. Nullable behind a proxy. */
  readonly ip?: string | null;
  /** Client user-agent for the login audit trail. Nullable. */
  readonly userAgent?: string | null;
  /**
   * "Remember me" preference — persisted on the session row so the
   * refresh handler can keep honouring the original intent across
   * rotations (AUD-FRM-AUTH-003). When false (default) the refresh
   * cookie is session-scoped; when true it persists for the full
   * refresh TTL.
   */
  readonly rememberMe?: boolean;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly role: string;
    readonly firmId: string;
  };
  readonly totpRequired: boolean;
}

/**
 * Handle login: email + password + optional TOTP.
 *
 * Returns null when TOTP is required but not provided (the caller
 * should return a 401 with `totp_required` code).
 */
export async function handleLogin(deps: AuthHandlerDeps, input: LoginInput): Promise<LoginResult> {
  const now = deps.clock?.() ?? new Date();
  const auditCtx = buildAuditContext({
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  // 1. Find user. Run a dummy argon2 verify against the shared
  //    timing-parity hash so the unknown-email branch pays the same
  //    wall-clock cost as the known-email path. Without this the
  //    latency delta is a remote enumeration oracle.
  const user = await deps.findUserByEmail(deps.db, input.email.toLowerCase().trim());
  if (user === null) {
    const dummyHash = await getDummyPasswordHash(deps.authConfig);
    await verifyPassword(input.password, dummyHash);
    recordAuthAttempt('password', 'failure');
    throw new AuthError('invalid_password', 'Invalid email or password.');
  }

  // The lock check used to fire here and surface `account_locked`,
  // which let a single-request attacker tell "email exists" apart
  // from "email unknown". It now runs *after* the password is
  // verified — a random-password spray cannot reach it, so the
  // legitimate owner can safely see the lock-window message.

  // 2. Verify password. A `null` password_hash ("invite not yet
  //    accepted" / SSO-only account) is treated like a wrong
  //    password: dummy verify + audit + invalid_password so the
  //    account's existence stays hidden.
  if (user.passwordHash === null) {
    const dummyHash = await getDummyPasswordHash(deps.authConfig);
    await verifyPassword(input.password, dummyHash);
    recordAuthAttempt('password', 'failure');
    await writeAudit(deps.db, {
      action: 'firm_user.login.failed',
      actor: systemActor('firm-auth'),
      target: uuidTarget({ kind: 'firm_user', id: user.id }),
      context: auditCtx,
      meta: { reason: 'no_password_set' },
      ts: now,
    });
    throw new AuthError('invalid_password', 'Invalid email or password.');
  }

  const passwordValid = await verifyPassword(input.password, user.passwordHash);
  if (!passwordValid) {
    recordAuthAttempt('password', 'failure');
    // F-A1-AUDIT-ATOMIC-001 (Path-B Pattern A-in-tx): the atomic
    // counter UPDATE + audit emit commit / roll back together so a
    // mid-audit DB error cannot leave the failed-login counter
    // incremented without a forensic-trail entry. NIST SP 800-92.
    // BUG #59 atomic counter UPDATE remains inside the helper.
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
        action: 'firm_user.login.failed',
        actor: systemActor('firm-auth'),
        target: uuidTarget({ kind: 'firm_user', id: user.id }),
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

      // F-XCC-AQ-LOCKOUT-NO-NOTIFY-003 — fire the user-facing email
      // leg only on the threshold-crossing edge so each lock cycle
      // produces exactly one notification. Audit row is the
      // login.failed entry above; this event's audit subscriber
      // returns null by design.
      if (justLocked) {
        await emitSecurityEvent({
          db: tx,
          eventType: 'firm_user.account_locked',
          subject: { kind: 'firm_user', id: user.id },
          payload: {
            auditContext: {
              ip: auditCtx.ip,
              userAgent: auditCtx.userAgent,
              requestId: auditCtx.requestId,
            },
            email: user.email,
            displayName: user.email.split('@')[0] ?? 'there',
            lockedUntil: lockUntil.toISOString(),
            reason: 'password',
          },
          now,
        });
      }
    });
    // F-XCC-AE Layer 2 (progressive delay / tarpit): hold the failure
    // response from the 3rd consecutive wrong-pwd onwards. On the
    // lock-trip commit the helper resets `failedLoginCount` to 0, so
    // we use MAX_FAILED_ATTEMPTS for delay purposes (the attempt that
    // tripped the lock effectively counted as the 5th).
    await sleep(
      getProgressiveDelayMs(
        justLockedForDelay ? MAX_FAILED_ATTEMPTS : failedLoginCountForDelay,
      ),
    );
    // Silent: surface `invalid_password` even on the lock-trip
    // commit. Throwing `account_locked` here would let a
    // random-password sprayer detect the threshold-crossing attempt
    // and confirm the email exists.
    throw new AuthError('invalid_password', 'Invalid email or password.');
  }

  recordAuthAttempt('password', 'success');

  // [POST-VERIFY LOCK CHECK]
  // The caller proved they know the password, so surfacing the real
  // lock state here is not an enumeration oracle. The legitimate
  // owner can see "try again in N minutes" instead of a confusing
  // `invalid_password` loop. F-A1-CROSS-PARITY-001 propagation —
  // central `assertFirmUserActiveFromRow` is the single-source lock
  // invariant; banned/suspended branches absent because schema does
  // not model them (P2 finding).
  try {
    assertFirmUserActiveFromRow(user, now);
  } catch (err) {
    if (err instanceof AuthError && err.code === 'account_locked') {
      await writeAudit(deps.db, {
        action: 'firm_user.login.failed',
        actor: systemActor('firm-auth'),
        target: uuidTarget({ kind: 'firm_user', id: user.id }),
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

  // Silent hash rotation. When the argon2id cost factors are raised
  // in AuthConfig, existing stored hashes become weaker than policy.
  // On the next successful login we transparently re-hash under the
  // current parameters and update the row. Invisible to the user;
  // the next verify runs against the stronger hash. Failures here
  // must never break login — log and move on.
  if (user.passwordHash !== null && needsRehash(user.passwordHash, deps.authConfig)) {
    try {
      const upgradedHash = await hashPassword(input.password, deps.authConfig);
      await deps.db.execute(
        sql`UPDATE firm_users SET password_hash = ${upgradedHash}, updated_at = ${now.toISOString()} WHERE id = ${user.id}`,
      );
    } catch (err) {
      getRootLogger().warn(
        {
          event: 'firm_login_hash_rotation_failed',
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        },
        'firm-login silent hash rotation failed',
      );
    }
  }

  // 4. Second-factor check. Either `totpCode` (primary path) or
  //    `recoveryCode` (backup path when the user has lost access to
  //    their authenticator) must be supplied when TOTP is enrolled.
  //    Both paths share the same failure handler so the brute-force
  //    lockout counter is defended against mix-and-match attacks.
  const totpEnrolled = user.totpEnrolledAt !== null;
  if (totpEnrolled) {
    const hasRecoveryCode = input.recoveryCode !== undefined && input.recoveryCode.length > 0;
    const hasTotpCode = input.totpCode !== undefined && input.totpCode.length > 0;

    if (!hasRecoveryCode && !hasTotpCode) {
      throw new AuthError('totp_not_enrolled', 'TOTP code is required.');
    }

    // Shared failure handler. Both TOTP and recovery-code fails go
    // through the same counter + lock path — without that, an
    // attacker could toggle between the two fields to get double
    // the keyspace per-lockout. Inlined as a local closure because
    // it captures `user`, `deps`, `now`, `auditCtx`; factoring it
    // into a module-scope helper would just hide the dependencies
    // without adding reuse.
    const failSecondFactor = async (
      reason: 'invalid_totp_code' | 'invalid_recovery_code',
    ): Promise<never> => {
      // BUG #59 fix: same atomic UPDATE as the password-fail branch
      // above. Two parallel TOTP/recovery attempts no longer share a
      // stale `user.failedLoginCount` snapshot.
      const lockUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
      const { failedLoginCount, justLocked } = await deps.incrementFailedLoginOrLock(
        deps.db,
        user.id,
        MAX_FAILED_ATTEMPTS,
        lockUntil,
        now,
      );
      if (justLocked) {
        await writeAudit(deps.db, {
          action: 'firm_user.login.failed',
          actor: systemActor('firm-auth'),
          target: uuidTarget({ kind: 'firm_user', id: user.id }),
          context: auditCtx,
          meta: {
            reason: reason === 'invalid_recovery_code' ? 'recovery_locked_now' : 'totp_locked_now',
            failedAttempts: MAX_FAILED_ATTEMPTS,
            lockedUntil: lockUntil.toISOString(),
          },
          ts: now,
        });
        // F-XCC-AQ-LOCKOUT-NO-NOTIFY-003 — second-factor lockout
        // notification (the password-fail branch above is the other
        // entry point). Same email template, the `reason` field on
        // the payload tells incident response which credential leg
        // tripped the threshold.
        await emitSecurityEvent({
          db: deps.db,
          eventType: 'firm_user.account_locked',
          subject: { kind: 'firm_user', id: user.id },
          payload: {
            auditContext: {
              ip: auditCtx.ip,
              userAgent: auditCtx.userAgent,
              requestId: auditCtx.requestId,
            },
            email: user.email,
            displayName: user.email.split('@')[0] ?? 'there',
            lockedUntil: lockUntil.toISOString(),
            reason: reason === 'invalid_recovery_code' ? 'recovery_code' : 'totp',
          },
          now,
        });
        throw new AuthError(
          'account_locked',
          reason === 'invalid_recovery_code'
            ? 'Account is temporarily locked due to too many failed recovery-code attempts. Please try again later.'
            : 'Account is temporarily locked due to too many failed TOTP attempts. Please try again later.',
        );
      }
      await writeAudit(deps.db, {
        action: 'firm_user.login.failed',
        actor: systemActor('firm-auth'),
        target: uuidTarget({ kind: 'firm_user', id: user.id }),
        context: auditCtx,
        meta: { reason, failedAttempts: failedLoginCount },
        ts: now,
      });
      // F-XCC-AE Layer 2 (progressive delay / tarpit): 2FA wrong-code
      // path mirrors the password-fail tarpit. Same threshold (3rd
      // attempt onward) since attacker can rotate password ↔ TOTP ↔
      // recovery-code keyspaces without resetting the counter.
      await sleep(getProgressiveDelayMs(failedLoginCount));
      throw new AuthError(
        reason,
        reason === 'invalid_recovery_code' ? 'Invalid recovery code.' : 'Invalid TOTP code.',
      );
    };

    if (hasRecoveryCode) {
      // Recovery-code path. Atomic `UPDATE ... RETURNING` burns the
      // matching row in a single statement so two concurrent logins
      // racing the same code end up with exactly one winner and one
      // invalid response.
      const codeHash = hashRecoveryCode(input.recoveryCode!);
      const claimed = await deps.db.execute<{ id: string }>(
        sql`UPDATE firm_user_recovery_codes
              SET used_at = ${now.toISOString()}
            WHERE firm_user_id = ${user.id}
              AND code_hash = ${codeHash}
              AND used_at IS NULL
            RETURNING id`,
      );
      if (claimed.rows.length === 0) {
        await failSecondFactor('invalid_recovery_code');
      }
      // Fall through to the happy path — password + recovery-code
      // verified, session creation below.
    } else {
      // TOTP path. Unchanged from the standard enrolment flow.
      if (
        user.totpSecretCiphertext === null ||
        user.totpSecretNonce === null ||
        user.totpKeyVersion === null
      ) {
        throw new AuthError('invalid_totp_secret', 'TOTP configuration is corrupt.');
      }

      const totpSecret = decryptTotpSecret(
        user.totpSecretCiphertext,
        user.totpSecretNonce,
        user.totpKeyVersion,
        deps.authConfig.totpEncryptionKey,
      );

      // BUG #54 fix: `verifyAndConsumeTotpCode` records the matched
      // counter in `totp_used_codes` so the same 6-digit code cannot
      // be replayed within the drift window — RFC 6238 §5.2.
      const valid = await verifyAndConsumeTotpCode(
        deps.db,
        user.id,
        'firm',
        totpSecret,
        input.totpCode!,
        deps.authConfig,
      );
      if (!valid) {
        await failSecondFactor('invalid_totp_code');
      }
    }
  }

  // 5. Find firm
  const firm = await deps.findFirmById(deps.db, user.firmId);
  assertFirmActive(firm);

  // 6. Build session
  const session = await buildSession(
    {
      kind: 'firm',
      userId: user.id,
      firmId: user.firmId,
      role: user.role,
      ip: null,
      userAgent: null,
    },
    deps.authConfig,
    now,
  );

  // New-device alert — probed BEFORE we insert the new session
  // so the probe does not count the row we are about to create.
  // Shared helper across customer / firm / admin.
  await dispatchNewDeviceAlert({
    db: deps.db,
    audience: 'firm',
    userId: user.id,
    email: user.email,
    displayName: user.email.split('@')[0] ?? 'there',
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    now,
    securityUrlPath: '/dashboard/settings/security',
  });

  // 7. Single session enforcement + persist new session.
  //
  // Race fix (BUG #50 firm side): wrap revoke + insert in one
  // transaction guarded by a per-user advisory lock so concurrent
  // logins serialize. Without the lock, two parallel /login POSTs
  // both saw the same prior active set, both revoked it, and both
  // inserted — producing N concurrent active sessions per firm user
  // (runtime-reproduced 2026-04-26 with timing-dependent state
  // 1 alive / 1 revoked OR 2 alive). The migration
  // `20260427000000_session_active_unique.sql` adds the matching
  // partial unique index `sessions_active_uniq (user_id, user_kind)
  // WHERE revoked_at IS NULL` as the DB-level safety net.
  await deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'firm_login:' + user.id}))`,
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
      // Persist rememberMe so refresh rotation honours it (AUD-FRM-AUTH-003).
      rememberMe: input.rememberMe ?? false,
    });
  });

  // F-XCC-AE Layer 2 (timing-oracle close): if the pre-state counter
  // had already entered the tarpit zone, hold the success response
  // for the same delay we'd have applied on a wrong-pwd attempt.
  // Without this mirror the tarpit becomes the side-channel oracle.
  if (user.failedLoginCount >= PROGRESSIVE_DELAY_THRESHOLD) {
    await sleep(getProgressiveDelayMs(user.failedLoginCount));
  }

  await deps.resetFailedLogin(deps.db, user.id, now);

  // F-A1-J-AUTH-SUCCESS-001 — 3-audience parity for login.success
  // audit. Customer side already emits the matching row at
  // `route.ts::POST /api/customer/auth/login`; firm + admin were
  // emitting only on the `.failed` leg, leaving the SOC dashboard
  // unable to compute a per-user "successful logins / failed logins"
  // ratio. Action name was already in the audit catalog.
  await writeAudit(deps.db, {
    action: 'firm_user.login.success',
    actor: systemActor('firm-auth'),
    target: uuidTarget({ kind: 'firm_user', id: user.id }),
    context: auditCtx,
    meta: { totpUsed: totpEnrolled, rememberMe: input.rememberMe ?? false },
    ts: now,
  });

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.accessExpiresAt,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      firmId: user.firmId,
    },
    totpRequired: totpEnrolled,
  };
}

/* ---------- Logout ---------- */

/**
 * Revoke the current session.
 */
export async function handleLogout(
  deps: Pick<AuthHandlerDeps, 'db' | 'revokeSession' | 'findSessionByJti' | 'clock'>,
  jti: string,
): Promise<void> {
  const now = deps.clock?.() ?? new Date();
  const session = await deps.findSessionByJti(deps.db, jti);
  if (session === null) return; // already gone
  if (session.revokedAt !== null) return; // already revoked
  await deps.revokeSession(deps.db, session.id, 'user_logout', now);
}

/* ---------- Refresh ---------- */

export interface RefreshInput {
  readonly refreshToken: string;
  readonly jti: string;
}

export interface RefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
}

/**
 * Rotate the refresh token and issue a new access token.
 */
export async function handleRefresh(
  deps: Pick<
    AuthHandlerDeps,
    | 'db'
    | 'authConfig'
    | 'clock'
    | 'findSessionByJti'
    | 'findUserById'
    | 'revokeSession'
    | 'updateSessionAfterRotate'
  >,
  input: RefreshInput,
): Promise<RefreshResult> {
  const now = deps.clock?.() ?? new Date();

  // 1. Find session
  const session = await deps.findSessionByJti(deps.db, input.jti);
  if (session === null) {
    throw new AuthError('invalid_refresh_token', 'Session not found.');
  }
  if (session.revokedAt !== null) {
    throw new AuthError('invalid_refresh_token', 'Session has been revoked.');
  }
  if (session.refreshExpiresAt < now) {
    throw new AuthError('invalid_refresh_token', 'Refresh token has expired.');
  }

  // 2. Verify refresh token
  if (!verifyRefreshToken(input.refreshToken, session.refreshTokenHash)) {
    // Possible token theft — revoke the session
    await deps.revokeSession(deps.db, session.id, 'refresh_token_mismatch', now);
    throw new AuthError('refresh_token_mismatch', 'Refresh token mismatch. Session revoked.');
  }

  // 3. Look up user for role
  const user = await deps.findUserById(deps.db, session.userId);
  if (user === null) {
    throw new AuthError('invalid_refresh_token', 'User not found.');
  }

  // 4. Rotate
  const rotated = await rotateSession(
    {
      userId: session.userId,
      kind: 'firm',
      firmId: user.firmId,
      role: user.role,
      previousRefreshTokenVersion: session.refreshTokenVersion,
    },
    deps.authConfig,
    now,
  );

  // 5. Update session row
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

/* ---------- TOTP Setup ---------- */

export interface TotpSetupResult {
  readonly secret: string;
  readonly otpauthUrl: string;
}

/**
 * Generate a new TOTP secret for the user. Does NOT persist until
 * the user verifies the code via the verify endpoint.
 */
export function handleTotpSetup(
  deps: Pick<AuthHandlerDeps, 'authConfig'>,
  userEmail: string,
): TotpSetupResult {
  const secret = generateTotpSecret();
  const url = buildOtpauthUrl(secret, userEmail, deps.authConfig);
  return { secret, otpauthUrl: url };
}

/* ---------- TOTP Verify (enrollment) ---------- */

export interface TotpVerifyInput {
  readonly userId: string;
  readonly secret: string;
  readonly code: string;
}

/**
 * Verify a TOTP code during enrollment. On success, encrypts and
 * persists the secret.
 */
export async function handleTotpVerify(
  deps: Pick<AuthHandlerDeps, 'db' | 'authConfig' | 'saveTotpSecret' | 'clock'>,
  input: TotpVerifyInput,
): Promise<void> {
  const now = deps.clock?.() ?? new Date();

  // Verify the code
  const valid = verifyTotpCode(input.secret, input.code, deps.authConfig);
  if (!valid) {
    throw new AuthError('invalid_totp_code', 'Invalid TOTP code. Please try again.');
  }

  // Encrypt the secret
  const encKey = loadKeyFromBase64(deps.authConfig.totpEncryptionKey);
  const sealed = seal(input.secret, encKey, deps.authConfig.totpEncryptionKeyVersion);

  // Store ciphertext + tag concatenated, nonce separately (matches DB schema)
  const ciphertextWithTag = Buffer.concat([sealed.ciphertext, sealed.tag]).toString('base64');
  const nonceB64 = Buffer.from(sealed.nonce).toString('base64');

  await deps.saveTotpSecret(
    deps.db,
    input.userId,
    ciphertextWithTag,
    nonceB64,
    deps.authConfig.totpEncryptionKeyVersion,
    now,
  );
}
