/**
 * Customer login logic.
 *
 * Flow: find customer → check status → verify password → handle
 * failed attempts → revoke existing sessions (single session) →
 * create session → sign JWT → return tokens.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import type { AuthConfig } from '@/lib/auth/config';
import { getDummyPasswordHash } from '@/lib/auth/dummy-hash';
import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import { signAccessToken, generateRefreshToken } from '@/lib/auth/jwt';
import { getRootLogger } from '@/lib/observability/logger';
import { recordAuthAttempt } from '@/lib/observability/request-metrics';
import { parseDeviceName } from '@/lib/auth/device-name';
import { dispatchNewDeviceAlert } from '@/lib/auth/new-device-alert';
import {
  FAILED_LOGIN_DECAY_SECONDS,
  PROGRESSIVE_DELAY_THRESHOLD,
  getProgressiveDelayMs,
  sleep,
} from '@/lib/auth/lockout';

import { systemActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { emitSecurityEvent } from '@/lib/security-events';

import type { CustomerAuthConfig } from './config';
import { CustomerError } from './errors';
import { assertCustomerActiveFromRow } from './status-check';

export { resetDummyPasswordHashCacheForTests } from '@/lib/auth/dummy-hash';

export interface LoginCustomerParams {
  readonly email: string;
  readonly password: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly rememberMe?: boolean;
}

export interface LoginCustomerResult {
  readonly customerId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
  readonly rememberMe: boolean;
}

/**
 * Authenticate a customer by email + password.
 *
 * On success:
 * 1. Revokes ALL existing sessions for the customer (single session enforcement).
 * 2. Creates a new customer_sessions row.
 * 3. Returns signed tokens.
 *
 * On failure, increments failed_login_attempts. Locks after max attempts.
 */
export async function loginCustomer(
  db: CrivacyDatabase,
  authConfig: AuthConfig,
  customerConfig: CustomerAuthConfig,
  params: LoginCustomerParams,
  clock: () => Date = () => new Date(),
): Promise<LoginCustomerResult> {
  const now = clock();
  const emailLower = params.email.toLowerCase().trim();
  const rememberMe = params.rememberMe ?? false;

  // Find customer
  const customerResult = await db.execute<{
    id: string;
    email: string;
    password_hash: string | null;
    display_name: string | null;
    status: string;
    failed_login_attempts: number;
    failed_login_first_at: string | null;
    locked_at: string | null;
    email_verified_at: string | null;
    deleted_at: string | null;
  }>(
    sql`SELECT id, email, password_hash, display_name, status,
         failed_login_attempts, failed_login_first_at::text,
         locked_at::text, email_verified_at::text, deleted_at::text
     FROM customers
     WHERE lower(email) = ${emailLower}
     LIMIT 1`,
  );
  const customer = customerResult.rows[0] as {
    id: string;
    email: string;
    password_hash: string | null;
    display_name: string | null;
    status: string;
    failed_login_attempts: number;
    failed_login_first_at: string | null;
    locked_at: string | null;
    email_verified_at: string | null;
    deleted_at: string | null;
  } | undefined;

  if (!customer || customer.deleted_at !== null) {
    // Run a verify against the dummy hash so an attacker cannot
    // tell "email unknown" from "email known, wrong password" by
    // timing. The verify result is discarded — we always raise
    // invalid_credentials on this branch.
    const dummyHash = await getDummyPasswordHash(authConfig);
    await verifyPassword(params.password, dummyHash);
    recordAuthAttempt('password', 'failure');
    throw new CustomerError('invalid_credentials', 'Invalid email or password.');
  }

  // Status-specific errors (banned, suspended, locked) used to fire
  // *before* the password was verified. That turned the response
  // into a single-request enumeration oracle — any random password
  // on a banned email returned `account_banned`, confirming the
  // email was registered. Those checks now run *after* the password
  // is proven correct, so only the legitimate owner ever sees them;
  // a random-password spray cannot reach them.
  const auditCtx = buildAuditContext({ ip: params.ip, userAgent: params.userAgent });

  // Verify password — wallet-only users have no password_hash.
  // Same timing-uniformity reasoning as the unknown-email branch:
  // without the dummy verify, an attacker can distinguish a
  // password-less account (wallet-only) from a regular one by the
  // fact that this branch returns in microseconds.
  if (customer.password_hash === null) {
    const dummyHash = await getDummyPasswordHash(authConfig);
    await verifyPassword(params.password, dummyHash);
    await writeAudit(db, {
      action: 'customer.login.failed',
      actor: systemActor('customer-auth'),
      target: uuidTarget({ kind: 'customer', id: customer.id }),
      context: auditCtx,
      meta: { reason: 'no_password_set' },
      ts: now,
    });
    recordAuthAttempt('password', 'failure');
    throw new CustomerError('invalid_credentials', 'Invalid email or password.');
  }
  const passwordValid = await verifyPassword(params.password, customer.password_hash);
  if (!passwordValid) {
    recordAuthAttempt('password', 'failure');

    // F-A1-AUDIT-ATOMIC-001 (Path-B Pattern A-in-tx): the failed-
    // login counter UPDATE and the `customer.login.failed` audit row
    // commit / roll back together. Without the tx wrap a DB error
    // mid-audit would leave the counter incremented but no forensic
    // trail — incident response cannot reconstruct the lockout-
    // threshold crossing without the audit row. NIST SP 800-92.
    //
    // BUG #59 atomic counter UPDATE remains: a single statement
    // that increments AND conditionally trips the lock. Reading
    // `failed_login_attempts` inside the SET expression is
    // serialized by the row-level lock PostgreSQL takes for any
    // UPDATE; the CASE expressions trip the lock the first time
    // `failed_login_attempts + 1 >= max`.
    // F-XCC-AE Layer 1 (sliding-window decay): the same pre-state row
    // is read multiple times in the CASE expressions below, so the
    // `decayed` / `lockTrips` boolean is consistent within this single
    // UPDATE. PostgreSQL serialises concurrent writers via the row-
    // level lock — same race-safety property BUG #59 relied on.
    const nowIso = now.toISOString();
    const decayed = sql`(failed_login_first_at IS NULL OR EXTRACT(EPOCH FROM (${nowIso}::timestamptz - failed_login_first_at)) > ${FAILED_LOGIN_DECAY_SECONDS})`;
    const lockTrips = sql`(NOT ${decayed} AND failed_login_attempts + 1 >= ${customerConfig.maxFailedAttempts} AND status <> 'locked')`;
    let txNewCount = customer.failed_login_attempts + 1;
    await db.transaction(async (tx) => {
      const updateResult = await tx.execute<{
        failed_login_attempts: number;
        status: string;
      }>(
        sql`UPDATE customers
            SET failed_login_attempts = CASE
                  WHEN ${decayed} THEN 1
                  ELSE failed_login_attempts + 1
                END,
                failed_login_first_at = CASE
                  WHEN ${lockTrips} THEN NULL
                  WHEN ${decayed} THEN ${nowIso}::timestamptz
                  ELSE failed_login_first_at
                END,
                status = CASE
                  WHEN ${lockTrips}
                  THEN 'locked'
                  ELSE status
                END,
                locked_at = CASE
                  WHEN ${lockTrips}
                  THEN ${nowIso}::timestamptz
                  ELSE locked_at
                END,
                lock_reason = CASE
                  WHEN ${lockTrips}
                  THEN 'Too many failed login attempts'
                  ELSE lock_reason
                END,
                updated_at = ${nowIso}
            WHERE id = ${customer.id}
            RETURNING failed_login_attempts, status`,
      );
      const updatedRow = updateResult.rows[0] as
        | { failed_login_attempts: number; status: string }
        | undefined;
      const newCount =
        updatedRow?.failed_login_attempts ?? customer.failed_login_attempts + 1;
      txNewCount = newCount;
      // The threshold-crossing UPDATE is exactly the one whose
      // post-update counter equals `maxFailedAttempts`. Earlier
      // crossings can only happen under our own auto-unlock path,
      // which resets the counter to 0; later crossings produce
      // counters strictly greater than max. Equality picks out the
      // single locking commit per lock cycle.
      const justLocked = newCount === customerConfig.maxFailedAttempts;

      await writeAudit(tx, {
        action: 'customer.login.failed',
        actor: systemActor('customer-auth'),
        target: uuidTarget({ kind: 'customer', id: customer.id }),
        context: auditCtx,
        meta: justLocked
          ? { reason: 'account_locked_now', failedAttempts: newCount }
          : { reason: 'invalid_password', failedAttempts: newCount },
        ts: now,
      });

      // F-XCC-AQ-LOCKOUT-NO-NOTIFY-003 — fire the "your account was
      // locked" email leg only on the threshold-crossing edge so the
      // legitimate owner sees one mail per lock cycle instead of one
      // per failed attempt. Audit row already captured this above as
      // login.failed + meta.reason='account_locked_now', so the audit
      // subscriber returns null for `customer.account_locked`.
      if (justLocked && customer.email !== null) {
        const lockedUntil = new Date(
          now.getTime() + customerConfig.lockDurationMinutes * 60_000,
        );
        await emitSecurityEvent({
          db: tx,
          eventType: 'customer.account_locked',
          subject: { kind: 'customer', id: customer.id },
          payload: {
            auditContext: {
              ip: params.ip,
              userAgent: params.userAgent,
              requestId: auditCtx.requestId,
            },
            email: customer.email,
            displayName:
              customer.display_name ?? customer.email.split('@')[0] ?? 'there',
            lockedUntil: lockedUntil.toISOString(),
            reason: 'password',
          },
          now,
        });
      }
    });

    // F-XCC-AE Layer 2 (progressive delay / tarpit): hold the failure
    // response from the 3rd consecutive wrong-pwd onwards. Cumulative
    // attacker cost over a 5-shot lockout cycle ≈ 14s; legitimate
    // users with 1-2 typos see no delay at all. The delay also fires
    // on the lock-trip commit (newCount === maxAttempts → ≥ 3) so the
    // attack surface is uniform across the threshold-crossing edge.
    await sleep(getProgressiveDelayMs(txNewCount));

    // Collapse to invalid_credentials — surfacing "account_locked"
    // here would confirm the email exists to an attacker that just
    // drove a random-password spray up to the lockout threshold.
    throw new CustomerError('invalid_credentials', 'Invalid email or password.');
  }

  // [POST-VERIFY STATUS CHECKS]
  // Reaching this point proves the caller knows the password.
  // Surfacing banned / locked / unverified-email states here is safe
  // because an unauthenticated attacker spraying random passwords
  // cannot get past the verify step above. AUD-X-ERROR-001: suspended
  // (reversible) vs banned (terminal) surface with distinct codes so
  // the UI can show an appeal path for the former.
  recordAuthAttempt('password', 'success');

  // assertCustomerActiveFromRow may perform an auto-unlock UPDATE
  // (expired-lock branch) but does NOT pair that UPDATE with an
  // audit emit — auto-unlock is silent. The throw branches
  // (banned/suspended/still-locked) write an audit row but commit
  // no other state mutation. Neither shape is an action+audit
  // coupling, so Pattern A inline (no tx wrap) is correct here —
  // F-A1-AUDIT-ATOMIC-001 scope intentionally leaves this site
  // alone.
  try {
    await assertCustomerActiveFromRow(
      db,
      {
        id: customer.id,
        status: customer.status,
        emailVerifiedAt: customer.email_verified_at,
        lockedAt: customer.locked_at,
      },
      customerConfig,
      now,
    );
  } catch (err) {
    if (err instanceof CustomerError) {
      await writeAudit(db, {
        action: 'customer.login.failed',
        actor: systemActor('customer-auth'),
        target: uuidTarget({ kind: 'customer', id: customer.id }),
        context: auditCtx,
        meta:
          err.code === 'account_locked'
            ? { reason: 'account_locked', lockedAt: customer.locked_at }
            : { reason: err.code, status: customer.status },
        ts: now,
      });
    }
    throw err;
  }

  // Unverified email — owner sees a specific prompt to verify. This
  // is a password-flow invariant; OAuth/SSO callers skip it because
  // the IdP's verified-email claim is the equivalent assertion.
  if (customer.email_verified_at === null) {
    throw new CustomerError('email_not_verified', 'Please verify your email before signing in.');
  }

  // F-XCC-AE Layer 2 (timing-oracle close): if the pre-state counter
  // had already entered the tarpit zone, hold the success response
  // for the same delay we'd have applied on a wrong-pwd attempt. Mid-
  // attack a sprayer cannot tell "the password I just guessed was
  // correct" from "wrong" by response-time alone — without this
  // mirror, the tarpit itself becomes the side-channel oracle.
  if (customer.failed_login_attempts >= PROGRESSIVE_DELAY_THRESHOLD) {
    await sleep(getProgressiveDelayMs(customer.failed_login_attempts));
  }

  // Reset failed attempts on success — also clears the decay window
  // (F-XCC-AE Layer 1) so the next post-success wrong-pwd starts a
  // fresh accumulating run.
  if (
    customer.failed_login_attempts > 0 ||
    customer.failed_login_first_at !== null
  ) {
    await db.execute(
      sql`UPDATE customers
          SET failed_login_attempts = 0,
              failed_login_first_at = NULL,
              updated_at = ${now.toISOString()}
          WHERE id = ${customer.id}`,
    );
  }

  // Update last_login_at
  await db.execute(
    sql`UPDATE customers SET last_login_at = ${now.toISOString()}, updated_at = ${now.toISOString()} WHERE id = ${customer.id}`,
  );

  // Silent hash rotation. When we raise the argon2id cost factors
  // in AuthConfig, existing stored hashes become weaker than the
  // new policy. On the next successful login we transparently
  // re-hash the plaintext with current parameters and update the
  // row. The user sees nothing; the next verify runs against the
  // stronger hash. Failures here must not break login — log and
  // move on.
  if (customer.password_hash !== null && needsRehash(customer.password_hash, authConfig)) {
    try {
      const upgradedHash = await hashPassword(params.password, authConfig);
      await db.execute(
        sql`UPDATE customers SET password_hash = ${upgradedHash}, updated_at = ${now.toISOString()} WHERE id = ${customer.id}`,
      );
    } catch (err) {
      // Non-fatal: original argon2 verify succeeded, only the rehash
      // write failed. Log for visibility and continue.
      getRootLogger().warn(
        {
          event: 'customer_login_hash_rotation_failed',
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        },
        'customer-login silent hash rotation failed',
      );
    }
  }

  // New-device login alert — probed BEFORE we insert the new
  // session row, so the probe's "prior sessions" count does not
  // include the row we are about to create. Dispatch is best-
  // effort: a failed email never blocks login, and a failed login
  // after this point only costs one spurious alert (worth the
  // simpler ordering over post-insert exclusion joins).
  await dispatchNewDeviceAlert({
    db,
    audience: 'customer',
    userId: customer.id,
    email: customer.email,
    displayName:
      customer.display_name ??
      customer.email?.split('@')[0] ??
      'User',
    ip: params.ip,
    userAgent: params.userAgent,
    now,
    securityUrlPath: '/settings/security',
  });

  // Sign access token. `AuthConfig` is a structural superset of
  // `JwtConfig`, so passing it straight in is type-safe — the
  // signer only reads the `jwt*` fields.
  const signed = await signAccessToken(
    { kind: 'customer', sub: customer.id, role: 'customer' },
    authConfig,
    now,
  );

  // Generate refresh token
  const refresh = generateRefreshToken();
  const refreshTtlSeconds = rememberMe
    ? customerConfig.customerRememberMeTtlDays * 86400
    : customerConfig.customerRefreshTtlSeconds;
  const refreshExpiresAt = new Date(now.getTime() + refreshTtlSeconds * 1000);

  // --- Single session enforcement (BUG #50 race fix): revoke ALL
  // existing active sessions and INSERT the fresh one inside a single
  // transaction guarded by a per-customer advisory lock. Without the
  // lock two parallel logins can both observe the same prior active
  // set, both revoke it, and both INSERT — producing N concurrent
  // active sessions for one customer (runtime-reproduced 2026-04-26).
  // The matching partial unique index `customer_sessions_active_uniq`
  // on `(customer_id) WHERE revoked_at IS NULL` (migration
  // `20260427000000_session_active_unique.sql`) is the DB-level
  // safety net that catches any race that slips past the app lock.
  const sessionRow = await db.transaction(async (tx) => {
    // hashtext() collapses uuid -> int4; the namespace string keeps
    // this lock disjoint from any other advisory lock domain.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'customer_login:' + customer.id}))`,
    );
    await tx.execute(
      sql`UPDATE customer_sessions
       SET revoked_at = ${now.toISOString()}, revoked_reason = 'superseded_by_new_login'
       WHERE customer_id = ${customer.id} AND revoked_at IS NULL`,
    );
    const sessionResult = await tx.execute<{ id: string }>(
      sql`INSERT INTO customer_sessions
       (customer_id, jwt_jti, refresh_token_hash, refresh_token_version, ip, user_agent, device_name, remember_me, issued_at, expires_at, refresh_expires_at, last_active_at, created_at)
       VALUES (${customer.id}, ${signed.jti}, ${refresh.tokenHash}, 1, ${params.ip}, ${params.userAgent}, ${parseDeviceName(params.userAgent)}, ${rememberMe}, ${now.toISOString()}, ${signed.expiresAt.toISOString()}, ${refreshExpiresAt.toISOString()}, ${now.toISOString()}, ${now.toISOString()})
       RETURNING id`,
    );
    return sessionResult.rows[0] as { id: string } | undefined;
  });
  if (!sessionRow) {
    throw new Error('Failed to create customer session');
  }

  return {
    customerId: customer.id,
    accessToken: signed.token,
    refreshToken: refresh.token,
    accessTokenExpiresAt: signed.expiresAt,
    refreshTokenExpiresAt: refreshExpiresAt,
    sessionId: sessionRow.id,
    rememberMe,
  };
}
