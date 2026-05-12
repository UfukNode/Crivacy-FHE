/**
 * Password reset — consume 6-digit code and set new password.
 *
 * The customer submits email + code + new password. We verify the code
 * against the latest non-used, non-invalidated reset token for that
 * customer, then hash the new password, revoke all sessions, and update
 * the customer row.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import type { AuthConfig } from '@/lib/auth/config';
import { hashPassword } from '@/lib/auth/password';
import { assertPasswordNotPwned } from '@/lib/auth/pwned-passwords';
import { emitSecurityEvent } from '@/lib/security-events';
import type { AuditContextPayload } from '@/lib/security-events';
import { constantTimeHashEqual, hashSubmittedCode } from './verification-code';

export type ResetPasswordResult =
  | { readonly status: 'reset'; readonly customerId: string }
  | { readonly status: 'expired' }
  | { readonly status: 'invalid' }
  | { readonly status: 'used' }
  | { readonly status: 'max_attempts' };

/** Pre-verify result — mirrors {@link ResetPasswordResult} minus `reset`/`used`. */
export type VerifyResetCodeResult =
  | { readonly status: 'valid' }
  | { readonly status: 'expired' }
  | { readonly status: 'invalid' }
  | { readonly status: 'max_attempts' };

/**
 * Reset a customer's password using email + 6-digit code.
 *
 * The `auditContext` + `displayName` parameters let the helper emit a
 * `customer.password_reset` event atomically with the mutation —
 * previously the caller wrote audit + dispatched the notification
 * email inline AFTER this function returned, which left a window
 * where the state had committed but the audit trail was still being
 * written. Passing the request context in lets the helper colocate
 * the emit with the UPDATE inside a single transaction.
 */
export async function resetPassword(
  db: CrivacyDatabase,
  authConfig: Pick<AuthConfig, 'passwordArgon2MemoryKib' | 'passwordArgon2Iterations' | 'passwordArgon2Parallelism' | 'passwordMinLength'>,
  email: string,
  rawCode: string,
  newPassword: string,
  auditContext: AuditContextPayload,
  displayName: string,
  maxAttempts: number = 5,
  clock: () => Date = () => new Date(),
): Promise<ResetPasswordResult> {
  const now = clock();
  const emailLower = email.toLowerCase().trim();
  const codeHash = hashSubmittedCode(rawCode);

  // Find customer by email
  const customerResult = await db.execute<{
    id: string;
    status: string;
    email_verified_at: string | null;
    deleted_at: string | null;
  }>(
    sql`SELECT id, status, email_verified_at::text, deleted_at::text
     FROM customers
     WHERE lower(email) = ${emailLower} AND deleted_at IS NULL
     LIMIT 1`,
  );
  const customer = customerResult.rows[0] as {
    id: string;
    status: string;
    email_verified_at: string | null;
    deleted_at: string | null;
  } | undefined;

  if (!customer) {
    return { status: 'invalid' };
  }

  // Find the latest non-invalidated, non-used reset token for this customer
  const tokenResult = await db.execute<{
    id: string;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
    attempts: number;
    invalidated_at: string | null;
  }>(
    sql`SELECT id, token_hash, expires_at::text, used_at::text, attempts::int, invalidated_at::text
     FROM password_reset_tokens
     WHERE customer_id = ${customer.id}
       AND used_at IS NULL
       AND invalidated_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  const tokenRow = tokenResult.rows[0] as {
    id: string;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
    attempts: number;
    invalidated_at: string | null;
  } | undefined;

  // Collapse "no pending token" into the generic `invalid` response.
  // Previously this surfaced a distinct `no_pending_code` status
  // that let an attacker tell "email registered but no pending
  // reset" apart from "email not registered at all" in a single
  // request — a plain enumeration oracle.
  if (!tokenRow) {
    return { status: 'invalid' };
  }

  // Check expiry
  if (new Date(tokenRow.expires_at) < now) {
    return { status: 'expired' };
  }

  // Check code match — constant-time compare. Non-exploitable in
  // this flow (SHA-256 avalanche defeats gradient-descent timing
  // attacks on the plaintext code) but the convention keeps future
  // refactors safe by default.
  if (!constantTimeHashEqual(tokenRow.token_hash, codeHash)) {
    // Increment attempt count
    const newAttempts = tokenRow.attempts + 1;
    if (newAttempts >= maxAttempts) {
      await db.execute(
        sql`UPDATE password_reset_tokens
         SET attempts = ${newAttempts}, invalidated_at = ${now.toISOString()}
         WHERE id = ${tokenRow.id}`,
      );
      return { status: 'max_attempts' };
    }
    await db.execute(
      sql`UPDATE password_reset_tokens SET attempts = ${newAttempts} WHERE id = ${tokenRow.id}`,
    );
    return { status: 'invalid' };
  }

  // Code matches — before we spend the argon2 cost and overwrite
  // the stored hash, make sure the new password is not a known-
  // breached one. Same HIBP k-anonymity lookup used by register.
  await assertPasswordNotPwned(newPassword);

  // Hash new password
  const passwordHash = await hashPassword(newPassword, authConfig);

  // Atomic state change + event emit. Before this transaction was
  // introduced, the route handler wrote audit + dispatched the
  // notification email AFTER this helper returned — post-commit
  // inline dispatch with the familiar "state committed but trail
  // missing" gap if either threw. The outbox emit lives inside the
  // same transaction as the state mutation so both land or neither
  // does; the security-events worker fans out audit + email
  // asynchronously.
  //
  // Race guard: the token UPDATE adds `AND used_at IS NULL` so two
  // concurrent reset POSTs sharing the same single-use code can't
  // both flip the password_hash. Whichever transaction consumes the
  // token first wins; the loser's UPDATE returns 0 rows and we
  // throw `RaceLostMarker` to roll back the entire transaction.
  // Without this guard a paralel POST resulted in 2x customer
  // password_hash UPDATEs from the same code (last-write-wins).
  const RaceLostMarker = Symbol('reset-password-race-lost');
  try {
    await db.transaction(async (tx) => {
      const tokenUpdate = await tx.execute(
        sql`UPDATE password_reset_tokens
         SET used_at = ${now.toISOString()}
         WHERE id = ${tokenRow.id} AND used_at IS NULL
         RETURNING id`,
      );
      if (tokenUpdate.rowCount === 0) {
        throw RaceLostMarker;
      }
      await tx.execute(
        sql`UPDATE customers
         SET password_hash = ${passwordHash},
             failed_login_attempts = 0,
             locked_at = NULL,
             lock_reason = NULL,
             status = CASE WHEN status = 'locked' THEN
               CASE WHEN email_verified_at IS NOT NULL THEN 'active'::customer_status ELSE 'pending_verification'::customer_status END
             ELSE status END,
             updated_at = ${now.toISOString()}
         WHERE id = ${customer.id}`,
      );
      await tx.execute(
        sql`UPDATE customer_sessions
         SET revoked_at = ${now.toISOString()}, revoked_reason = 'password_reset'
         WHERE customer_id = ${customer.id} AND revoked_at IS NULL`,
      );
      await emitSecurityEvent({
        db: tx,
        eventType: 'customer.password_reset',
        subject: { kind: 'customer', id: customer.id },
        payload: {
          auditContext,
          // Reset flow mints a fresh session on the next login rather
          // than continuing an existing one, so there is no session id
          // to record for this event.
          sessionId: null,
          email: emailLower,
          displayName,
          reason: 'reset',
          securityUrlPath: '/settings/security',
        },
        now,
      });
    });
  } catch (err) {
    if (err === RaceLostMarker) {
      return { status: 'used' };
    }
    throw err;
  }

  return { status: 'reset', customerId: customer.id };
}

/**
 * Pre-verify a reset code without consuming it — same guards as
 * {@link resetPassword} up to (but not including) the hash match's
 * write side. Wrong submits still count toward `attempts` so this
 * surface can't become an attempt-counter bypass.
 */
export async function verifyResetCode(
  db: CrivacyDatabase,
  email: string,
  rawCode: string,
  maxAttempts: number = 5,
  clock: () => Date = () => new Date(),
): Promise<VerifyResetCodeResult> {
  const now = clock();
  const emailLower = email.toLowerCase().trim();
  const codeHash = hashSubmittedCode(rawCode);

  const customerResult = await db.execute<{ id: string }>(
    sql`SELECT id FROM customers WHERE lower(email) = ${emailLower} AND deleted_at IS NULL LIMIT 1`,
  );
  const customer = customerResult.rows[0] as { id: string } | undefined;
  if (!customer) {
    return { status: 'invalid' };
  }

  const tokenResult = await db.execute<{
    id: string;
    token_hash: string;
    expires_at: string;
    attempts: number;
  }>(
    sql`SELECT id, token_hash, expires_at::text, attempts::int
          FROM password_reset_tokens
         WHERE customer_id = ${customer.id}
           AND used_at IS NULL
           AND invalidated_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
  );
  const tokenRow = tokenResult.rows[0] as
    | { id: string; token_hash: string; expires_at: string; attempts: number }
    | undefined;
  // Same collapse as the full-reset path: a distinct status here
  // would tell an attacker the email is registered without them
  // having to guess a code correctly.
  if (!tokenRow) {
    return { status: 'invalid' };
  }
  if (new Date(tokenRow.expires_at) < now) {
    return { status: 'expired' };
  }

  if (!constantTimeHashEqual(tokenRow.token_hash, codeHash)) {
    const newAttempts = tokenRow.attempts + 1;
    if (newAttempts >= maxAttempts) {
      await db.execute(
        sql`UPDATE password_reset_tokens
              SET attempts = ${newAttempts}, invalidated_at = ${now.toISOString()}
            WHERE id = ${tokenRow.id}`,
      );
      return { status: 'max_attempts' };
    }
    await db.execute(
      sql`UPDATE password_reset_tokens
            SET attempts = ${newAttempts}
          WHERE id = ${tokenRow.id}`,
    );
    return { status: 'invalid' };
  }

  return { status: 'valid' };
}
