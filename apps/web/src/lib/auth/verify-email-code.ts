/**
 * Atomic one-time-code verification primitive.
 *
 * Every short-lived numeric-code flow in the app — customer email
 * verification, customer password reset, firm-user password reset —
 * stores an attempt-counted, TTL-bound token row and later needs to
 * answer one question: "does the submitted code match, and if not,
 * what was wrong?".
 *
 * Before this module the answer lived as a hand-rolled three-statement
 * dance in each verify handler (SELECT row → compare → UPDATE attempts
 * or used_at), which carried a TOCTOU race: two parallel submissions
 * both read `attempts: N`, both wrote `attempts: N+1`, and an attacker
 * could consume many more attempts than `MAX_CODE_ATTEMPTS`. Concurrent
 * requests could also both "win" a correct code before either one
 * burned the row.
 *
 * {@link verifyEmailCode} replaces the dance with two atomic UPDATEs:
 *
 *   1. Try to burn the row via `UPDATE ... SET used_at = now() WHERE id =
 *      (latest active row AND token_hash = $hash AND not expired)`.
 *      A returned row proves the caller had the correct code AND beat
 *      every concurrent submission to the burn. No extra check needed.
 *
 *   2. If (1) returned 0 rows, try `UPDATE ... SET attempts = attempts + 1,
 *      invalidated_at = (reached max ? now() : invalidated_at) WHERE id =
 *      (latest active row AND not expired)`. The `attempts + 1` arithmetic
 *      runs server-side, so every concurrent submission pushes the counter
 *      by exactly one — no lost increments.
 *
 *   3. If both returned 0 rows, fall through to a diagnostic SELECT that
 *      tells the caller WHY nothing matched (expired / used / invalidated
 *      / never existed). The caller surfaces an appropriate error message
 *      without leaking how close the attacker got — the auth rate-limit
 *      layer is responsible for global brute-force defence, this primitive
 *      just reports state.
 *
 * The subject-scoping (customer_id vs firm_user_id) and the table name
 * are captured in {@link TokenTableConfig}, a closed union of approved
 * configurations. There is no way to pass an arbitrary table name into
 * this function — SQL identifier interpolation happens via `sql.raw()`
 * only on typed-literal members of the union, so an attacker-controlled
 * string cannot reach the identifier position.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';

import { hashSubmittedCode } from '@/lib/customer/verification-code';

/* -------------------------------------------------------------------------- */
/*  Table configuration                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Identifies one of the three one-time-code tables the app operates. A
 * closed union by design: any new code-backed flow must register its
 * table here, and the corresponding migration must match the canonical
 * column shape (`id, <subject>_id, token_hash, expires_at, used_at,
 * attempts, invalidated_at, created_at[, ip_address?]`). Reusing the
 * same shape across audiences keeps the primitive tiny and makes
 * cross-audience drift caught at compile time.
 *
 * `supportsIpAddress` flags the two reset tables that keep an audit
 * breadcrumb of the requester's IP — the issue-side primitive writes
 * that column only when the flag is true, and `verifyEmailCode` never
 * reads it.
 */
export interface TokenTableConfig {
  readonly tableName:
    | 'email_verification_tokens'
    | 'password_reset_tokens'
    | 'firm_user_password_reset_tokens';
  readonly subjectColumn: 'customer_id' | 'firm_user_id';
  readonly supportsIpAddress: boolean;
}

/** Customer email verification — registration + email-change flows. */
export const CUSTOMER_EMAIL_VERIFICATION_TABLE: TokenTableConfig = {
  tableName: 'email_verification_tokens',
  subjectColumn: 'customer_id',
  supportsIpAddress: false,
};

/** Customer forgot-password flow. */
export const CUSTOMER_PASSWORD_RESET_TABLE: TokenTableConfig = {
  tableName: 'password_reset_tokens',
  subjectColumn: 'customer_id',
  supportsIpAddress: true,
};

/** Firm-user forgot-password flow. */
export const FIRM_PASSWORD_RESET_TABLE: TokenTableConfig = {
  tableName: 'firm_user_password_reset_tokens',
  subjectColumn: 'firm_user_id',
  supportsIpAddress: true,
};

/* -------------------------------------------------------------------------- */
/*  Result shape                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Disjoint-union return type. Each variant carries exactly the payload
 * the caller needs to produce a user-facing error without having to
 * re-query the DB.
 */
export type VerifyCodeResult =
  /** Code matched and the row is now burned (used_at stamped). */
  | { readonly status: 'match'; readonly tokenId: string }
  /** Code did not match; an active row's attempts counter was bumped. */
  | { readonly status: 'mismatch'; readonly remainingAttempts: number }
  /**
   * Code did not match AND the attempts counter reached the cap on this
   * submission. The row was just invalidated; the caller should prompt
   * the user to request a fresh code.
   */
  | { readonly status: 'exhausted' }
  /** Latest row exists but its TTL lapsed before this submission arrived. */
  | { readonly status: 'expired' }
  /**
   * Latest row was invalidated by a previous operation — either an
   * earlier attempt cap, a newer code that superseded it, or an
   * explicit server-side cancellation.
   */
  | { readonly status: 'invalidated' }
  /** Latest row already consumed by a prior successful submission. */
  | { readonly status: 'used' }
  /** No token row has ever been created for this subject. */
  | { readonly status: 'not_found' };

/* -------------------------------------------------------------------------- */
/*  Input shape                                                                */
/* -------------------------------------------------------------------------- */

export interface VerifyCodeInput {
  readonly db: CrivacyDatabase;
  readonly table: TokenTableConfig;
  /** Owning customer or firm-user UUID. */
  readonly subjectId: string;
  /** Raw code as submitted by the user (whitespace/dashes tolerated). */
  readonly submittedCode: string;
  /**
   * Maximum attempts before the row is invalidated. Callers read this
   * from `customerConfig.maxCodeAttempts` / equivalent so the policy
   * stays a single source of truth.
   */
  readonly maxAttempts: number;
  /** Clock injection — test harness overrides, prod passes `new Date()`. */
  readonly now: Date;
}

/* -------------------------------------------------------------------------- */
/*  Verify                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Atomically verify a one-time code against the latest active row for
 * `subjectId` in the configured token table.
 *
 * See the module-level comment for the full algorithm + race analysis.
 * Callers should treat every non-`match` result as a failure — even
 * `mismatch` is a signal to reject the action, just with the extra
 * data that the user still has retries left.
 */
export async function verifyEmailCode(input: VerifyCodeInput): Promise<VerifyCodeResult> {
  const { db, table, subjectId, submittedCode, maxAttempts, now } = input;
  const codeHash = hashSubmittedCode(submittedCode);
  const nowIso = now.toISOString();

  // --- Step 1. Atomic burn-on-match --------------------------------------
  //
  // The subquery picks the most recent row that is simultaneously (a)
  // owned by this subject, (b) has its hash equal to the submitted code,
  // (c) not yet used, (d) not invalidated, and (e) within its TTL. We
  // take `FOR UPDATE` to serialise any concurrent writer behind us — if
  // two requests carry the correct code, the second one reads after the
  // first's COMMIT sees a `used_at` stamp and falls through to step 2.
  //
  // Dynamic identifiers: `tableName` / `subjectColumn` are union members,
  // not caller-controlled strings — the TypeScript type narrows them to
  // the three approved tables at the call site, so `sql.raw()` below is
  // safe by construction.
  const tableIdent = sql.raw(`"${table.tableName}"`);
  const subjectIdent = sql.raw(`"${table.subjectColumn}"`);

  const matchResult = await db.execute<{ id: string }>(
    sql`
      UPDATE ${tableIdent}
         SET used_at = ${nowIso}
       WHERE id = (
         SELECT id FROM ${tableIdent}
          WHERE ${subjectIdent} = ${subjectId}
            AND token_hash = ${codeHash}
            AND used_at IS NULL
            AND invalidated_at IS NULL
            AND expires_at > ${nowIso}
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
       )
       RETURNING id
    `,
  );
  const matchRow = matchResult.rows[0] as { id: string } | undefined;
  if (matchRow !== undefined) {
    return { status: 'match', tokenId: matchRow.id };
  }

  // --- Step 2. Atomic attempts++ on the active row -----------------------
  //
  // We reach here when no row had the correct hash — but an active row
  // might still exist (user typed the wrong code). Bump its counter. If
  // this bump crosses the cap, invalidate the row in the same UPDATE so
  // subsequent submissions land in step 3 with `invalidated` rather
  // than continuing to increment.
  //
  // `attempts + 1` runs server-side: two concurrent submissions become
  // two serialised UPDATEs and the counter moves by exactly 2.
  const mismatchResult = await db.execute<{
    attempts: number;
    invalidated_at: string | null;
  }>(
    sql`
      UPDATE ${tableIdent}
         SET attempts = attempts + 1,
             invalidated_at = CASE
               WHEN attempts + 1 >= ${maxAttempts} THEN ${nowIso}
               ELSE invalidated_at
             END
       WHERE id = (
         SELECT id FROM ${tableIdent}
          WHERE ${subjectIdent} = ${subjectId}
            AND used_at IS NULL
            AND invalidated_at IS NULL
            AND expires_at > ${nowIso}
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
       )
       RETURNING attempts, invalidated_at::text
    `,
  );
  const mismatchRow = mismatchResult.rows[0] as
    | { attempts: number; invalidated_at: string | null }
    | undefined;
  if (mismatchRow !== undefined) {
    // Postgres returns the post-update value; compare against the cap to
    // tell "one-more-strike" from "just-invalidated".
    if (mismatchRow.invalidated_at !== null) {
      return { status: 'exhausted' };
    }
    const remainingAttempts = Math.max(0, maxAttempts - mismatchRow.attempts);
    return { status: 'mismatch', remainingAttempts };
  }

  // --- Step 3. Diagnose why no active row existed ------------------------
  //
  // Read-only: we look at the most recent row (if any) to decide which
  // terminal state to report. A caller that sees `expired` can surface
  // "your code expired" and offer a resend; `used` means the flow
  // already succeeded in another tab; `invalidated` means attempts were
  // already exhausted earlier or a newer code superseded this one.
  const diagnosticResult = await db.execute<{
    used_at: string | null;
    invalidated_at: string | null;
    expires_at: string;
  }>(
    sql`
      SELECT used_at::text,
             invalidated_at::text,
             expires_at::text
        FROM ${tableIdent}
       WHERE ${subjectIdent} = ${subjectId}
       ORDER BY created_at DESC
       LIMIT 1
    `,
  );
  const diagnosticRow = diagnosticResult.rows[0] as
    | { used_at: string | null; invalidated_at: string | null; expires_at: string }
    | undefined;

  if (diagnosticRow === undefined) {
    return { status: 'not_found' };
  }
  if (diagnosticRow.used_at !== null) {
    return { status: 'used' };
  }
  if (diagnosticRow.invalidated_at !== null) {
    return { status: 'invalidated' };
  }
  if (new Date(diagnosticRow.expires_at) <= now) {
    return { status: 'expired' };
  }
  // Fallback — a row exists, it's not used/invalidated/expired, yet step
  // 2 failed to update it. This means another transaction burned or
  // invalidated it in between our two UPDATEs. Treat as `invalidated`
  // (the most conservative reading that does not over-promise "try
  // again" to the caller).
  return { status: 'invalidated' };
}
