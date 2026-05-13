/**
 * Customer registration logic.
 *
 * Flow: validate → check blacklist → check duplicate → hash password →
 * insert customer → create 6-digit verification code → return.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import type { AuthConfig } from '@/lib/auth/config';
import { hashPassword } from '@/lib/auth/password';
import { assertPasswordNotPwned } from '@/lib/auth/pwned-passwords';
import { issueShortLivedToken } from '@/lib/auth/short-lived-tokens';
import { CUSTOMER_EMAIL_VERIFICATION_TABLE } from '@/lib/auth/verify-email-code';

import { hashSubmittedCode } from './verification-code';
import { CustomerError } from './errors';

/**
 * F-A4-D4-001 — fixed-string baseline used to amortize argon2id work
 * on the `existing` / `blacklisted` short-circuit branches so the
 * register endpoint's median latency matches the `created` branch.
 *
 * Without this, the `created` branch hashes the submitted password
 * (~145 ms with the i-mode tuning at AuthConfig defaults) while the
 * other two return in ~5 ms — that 30× delta is a textbook timing
 * oracle for "does this email already have an account?" The Auth0 /
 * Stripe / Microsoft Entra B2C pattern is to pre-hash a fixed dummy
 * on the no-create branches; the resulting hash is **discarded**,
 * the only purpose is to spend the same CPU.
 *
 * The string itself is not security-relevant — argon2id is constant-
 * time on input length within a memory budget — so any non-empty
 * value works. 16 characters chosen to mirror typical password
 * length without crossing the i-mode cost curve.
 */
const DUMMY_PASSWORD_FOR_TIMING = 'x'.repeat(16);

export interface RegisterCustomerParams {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
  /**
   * AUD-X-COMP-006: stamped verbatim on the `customers` row so a
   * dispute can be settled with "the subject agreed to policy
   * version X at time Y". Required on every new registration — the
   * register route rejects missing/falsy agreement pre-call, so
   * this helper can assume it's supplied.
   */
  readonly termsVersion: string;
}

export interface RegisterCustomerResultCreated {
  readonly kind: 'created';
  readonly customerId: string;
  /** 6-digit verification code (to send via email). */
  readonly verificationCode: string;
  /** SHA-256 hash of the code (stored in DB). */
  readonly verificationCodeHash: string;
}

export interface RegisterCustomerResultExisting {
  /**
   * Email is already attached to a real (non-blacklisted, non-deleted)
   * customer row. The caller should return the generic success
   * response AND fire a "registration attempt" notification to the
   * real account holder so account-hijack attempts leave a trace in
   * the owner's inbox.
   */
  readonly kind: 'existing';
  readonly customerId: string;
}

export interface RegisterCustomerResultBlacklisted {
  /**
   * Email hash is on the abuse blacklist. Caller returns the generic
   * success response and does nothing else — notifying the attacker-
   * controlled inbox would be counterproductive.
   */
  readonly kind: 'blacklisted';
}

export type RegisterCustomerResult =
  | RegisterCustomerResultCreated
  | RegisterCustomerResultExisting
  | RegisterCustomerResultBlacklisted;

/**
 * Register a new customer.
 *
 * Returns a discriminated result the caller inspects to decide which
 * side effects to run (send verification email vs send "registration
 * attempt" notification vs silent drop). The outward-facing response
 * is identical across all three outcomes — this keeps the response
 * shape enumeration-proof while still letting the caller do the right
 * thing for the affected account.
 */
export async function registerCustomer(
  db: CrivacyDatabase,
  authConfig: Pick<AuthConfig, 'passwordArgon2MemoryKib' | 'passwordArgon2Iterations' | 'passwordArgon2Parallelism' | 'passwordMinLength'>,
  params: RegisterCustomerParams,
  codeTtlSeconds: number,
  clock: () => Date = () => new Date(),
): Promise<RegisterCustomerResult> {
  const now = clock();
  const emailLower = params.email.toLowerCase().trim();

  // Reject passwords that appear in public breach dumps BEFORE we
  // touch any row. Runs against HaveIBeenPwned via k-anonymity
  // prefix lookup — the plaintext never leaves this process. Placed
  // first so the rejection is independent of whether the email is
  // new / existing / blacklisted (same anti-enumeration reasoning as
  // the rest of this function's ordering).
  await assertPasswordNotPwned(params.password);

  // Check blacklist by email hash
  const emailHash = createHash('sha256').update(emailLower).digest('hex');
  const blacklisted = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM customer_blacklist WHERE email_hash = ${emailHash}`,
  );
  const blacklistRow = blacklisted.rows[0] as { count: string } | undefined;
  if (parseInt(blacklistRow?.count ?? '0', 10) > 0) {
    // F-A4-D4-001 timing parity — pay the argon2id cost on the
    // no-create path so the response timing does not leak whether
    // the submitted email is on the abuse blacklist.
    await hashPassword(DUMMY_PASSWORD_FOR_TIMING, authConfig);
    return { kind: 'blacklisted' };
  }

  // Check duplicate
  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM customers WHERE lower(email) = ${emailLower} AND deleted_at IS NULL LIMIT 1`,
  );
  const existingRow = existing.rows[0] as { id: string } | undefined;
  if (existingRow !== undefined) {
    // F-A4-D4-001 timing parity — pay the argon2id cost on the
    // no-create path so the response timing does not leak whether
    // the submitted email already has an account.
    await hashPassword(DUMMY_PASSWORD_FOR_TIMING, authConfig);
    return { kind: 'existing', customerId: existingRow.id };
  }

  // Hash password
  const passwordHash = await hashPassword(params.password, authConfig);

  // Insert customer. `terms_accepted_at` + `terms_version` stamped
  // atomically so we never have a row without proof of consent
  // (AUD-X-COMP-006).
  //
  // BUG #51 race fix: the prior SELECT-then-INSERT was non-atomic —
  // two parallel POSTs both observed "no row" and both attempted
  // INSERT; the loser hit a postgres 23505 unique_violation that
  // bubbled up as 500 `internal_error`. That divergence (200 winner
  // vs 500 loser) re-opened the enumeration oracle that the generic
  // "If this email is not already registered…" response was supposed
  // to close. The matching unique index is partial + expression-
  // indexed (`UNIQUE (lower(email)) WHERE deleted_at IS NULL AND
  // email IS NOT NULL`), so the conflict target has to mirror it
  // exactly — Postgres only matches `ON CONFLICT (col_or_expr)
  // WHERE …` against an index whose key list and predicate match
  // the statement. The losing race returns 0 rows; the route layer
  // and the SELECT-fallback below then map both winner and loser
  // to the same enum-safe 200 response.
  const insertResult = await db.execute<{ id: string }>(
    sql`INSERT INTO customers
          (email, password_hash, display_name, status, kyc_level, kyc_score,
           terms_accepted_at, terms_version, created_at, updated_at)
     VALUES (${params.email.trim()}, ${passwordHash}, ${params.displayName?.trim() ?? null},
             'pending_verification', 'kyc_0', 0,
             ${now.toISOString()}, ${params.termsVersion},
             ${now.toISOString()}, ${now.toISOString()})
     ON CONFLICT (lower(email)) WHERE deleted_at IS NULL AND email IS NOT NULL DO NOTHING
     RETURNING id`,
  );
  const customerRow = insertResult.rows[0] as { id: string } | undefined;
  if (!customerRow) {
    // Race lost — a parallel register POST committed first. Re-run
    // the duplicate lookup so we surface `kind: 'existing'` with the
    // winner's id; the caller maps both `created` and `existing` to
    // the same enum-safe 200 response.
    const racedRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM customers
       WHERE lower(email) = ${emailLower} AND deleted_at IS NULL
       LIMIT 1`,
    );
    const racedExisting = racedRow.rows[0] as { id: string } | undefined;
    if (racedExisting !== undefined) {
      return { kind: 'existing', customerId: racedExisting.id };
    }
    // Neither INSERT nor SELECT produced a row — DB invariant broken,
    // surface a real error rather than masking it.
    throw new CustomerError('email_already_registered', 'Failed to create customer');
  }

  // Create 6-digit verification code via the shared issuance primitive.
  // No prior pending tokens can exist for a just-created customer, so
  // the primitive's invalidate step is a no-op here; we opt into it
  // anyway because it's cheap and the primitive's contract guarantees
  // idempotency.
  const issued = await issueShortLivedToken({
    db,
    table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
    subjectId: customerRow.id,
    ttlSeconds: codeTtlSeconds,
    now,
  });

  return {
    kind: 'created',
    customerId: customerRow.id,
    verificationCode: issued.rawCode,
    verificationCodeHash: hashSubmittedCode(issued.rawCode),
  };
}
