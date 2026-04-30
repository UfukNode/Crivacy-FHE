/**
 * Postgres unique-violation detection + constrained retry helper.
 *
 * Every place in the app that does an "is this value already taken?"
 * SELECT followed by an UPDATE/INSERT has a classic TOCTOU race: two
 * concurrent callers both read "not taken", both write, and whichever
 * one lost the race bubbles a raw `23505` error — which the request
 * handlers currently surface as a generic 500 instead of a clean 409.
 *
 * The robust fix is to skip the pre-check entirely and let the DB's
 * unique index be the source of truth: attempt the write, let Postgres
 * raise `23505` on conflict, catch it precisely, and return a 409.
 * This module provides the two primitives callers need to do that
 * safely:
 *
 *   - {@link detectUniqueViolation} — pure inspector. Pass in a caught
 *     `err`, get back `null` if it wasn't a 23505 or `{ constraint,
 *     detail }` if it was.
 *
 *   - {@link runOrCatchUnique} — wraps an async op and converts a 23505
 *     on a whitelisted constraint into a tagged discriminated union.
 *     Anything else — including a 23505 on a constraint NOT in the
 *     whitelist — re-throws unchanged, because surfacing the wrong
 *     constraint as a generic 409 would mask a real bug.
 *
 * The constraint-name match is deliberate: matching on the SQLSTATE
 * alone would conflate `customers_email_key` with `customers_phone_key`
 * (both 23505), leading to "email already taken" messages on a phone
 * collision. We always pin on the constraint identifier.
 *
 * @module
 */

/* -------------------------------------------------------------------------- */
/*  SQLSTATE                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * PostgreSQL SQLSTATE for a unique-violation error. Also raised by
 * exclusion constraints (`23P01` — different code), which we do NOT
 * want to catch here.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/* -------------------------------------------------------------------------- */
/*  Detection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Structured read of a 23505 error. `constraint` is the index name that
 * fired (e.g. `customers_email_key`), `detail` is the human-readable
 * explanation Postgres attached (`Key (lower(email))=(x@y) already exists.`).
 *
 * Both fields are best-effort — node-postgres populates `constraint`
 * from the `C` protocol field, but some drivers expose it as
 * `constraint_name` instead; we check both.
 */
export interface UniqueViolation {
  readonly constraint: string;
  readonly detail: string | undefined;
}

/**
 * Inspect a caught error and return a {@link UniqueViolation} record
 * if it is a 23505, otherwise `null`. Never throws — safe to call
 * inside a catch block without nesting another try.
 *
 * Walks the `cause` chain (depth-bounded) because Drizzle wraps the
 * underlying `pg` error in a `Failed query: …` Error whose top-level
 * has no `code`/`constraint` fields. F-A5-BURN-001 (P5 audit): the
 * pre-fix detector read only the wrapper's `code` and returned null,
 * which made `runOrCatchUnique` re-throw legitimate replay/conflict
 * scenarios as 500 across 7 callsites (oauth-state-burn × 2,
 * profile-add-email, profile-verify-email-change, oauth-token,
 * rbac-sync, rbac-assignment).
 */
export function detectUniqueViolation(err: unknown): UniqueViolation | null {
  // Walk up to 4 levels of `cause` so a doubly-wrapped error (Drizzle
  // → pg-pool → pg) is still resolvable. Stops at the first frame
  // whose `code === 23505`; only that frame contributes the
  // `constraint` / `detail` fields, since outer wrappers do not carry
  // that metadata.
  let current: unknown = err;
  for (let depth = 0; depth < 4; depth++) {
    if (current === null || typeof current !== 'object') return null;
    const record = current as {
      readonly code?: unknown;
      readonly constraint?: unknown;
      readonly constraint_name?: unknown;
      readonly detail?: unknown;
      readonly cause?: unknown;
    };
    if (record.code === PG_UNIQUE_VIOLATION) {
      const constraint = record.constraint ?? record.constraint_name;
      // Postgres always populates the constraint name for a unique-violation
      // — if we reach here without one, something unusual is happening
      // (a wrapping driver layer swallowed the metadata) and we should NOT
      // classify the error, because the caller's whitelist match would be
      // meaningless.
      if (typeof constraint !== 'string' || constraint.length === 0) return null;
      const detail = typeof record.detail === 'string' ? record.detail : undefined;
      return { constraint, detail };
    }
    current = record.cause;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Constrained-retry wrapper                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Result of {@link runOrCatchUnique}. Discriminated on `status` so the
 * caller can switch without a separate try/catch.
 */
export type UniqueResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'violation'; readonly constraint: string; readonly detail: string | undefined };

/**
 * Run an async database op and convert a unique-violation on one of
 * the whitelisted constraints into a tagged failure. The whitelist is
 * required — passing an empty list means "no 23505 is acceptable from
 * this op", and any violation re-throws.
 *
 * @example
 *   const result = await runOrCatchUnique(
 *     () => db.execute(sql`UPDATE customers SET email = ${e} WHERE id = ${id}`),
 *     ['customers_email_key'],
 *   );
 *   if (result.status === 'violation') {
 *     return ctx.errorJson('email_taken', 'Email already in use.', 409);
 *   }
 *   // result.value holds the execute()'s return.
 */
export async function runOrCatchUnique<T>(
  op: () => Promise<T>,
  expectedConstraints: readonly string[],
): Promise<UniqueResult<T>> {
  try {
    const value = await op();
    return { status: 'ok', value };
  } catch (err) {
    const violation = detectUniqueViolation(err);
    if (violation === null) throw err;
    // Unknown constraint — re-throw so the 500 surfaces and we can
    // investigate rather than silently masking a distinct schema
    // conflict as the caller's "expected" failure.
    if (!expectedConstraints.includes(violation.constraint)) throw err;
    return { status: 'violation', constraint: violation.constraint, detail: violation.detail };
  }
}
