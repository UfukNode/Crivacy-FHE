// @vitest-environment node
/**
 * detectUniqueViolation + runOrCatchUnique — unit coverage.
 *
 * These helpers own a small but security-relevant contract: decide
 * whether a caught error is a "your email is already taken" signal or
 * a completely unrelated database failure. A bug here either swallows
 * a real error (masking a wider bug as a UX-level 409) or misses a
 * real 23505 (returning 500 where a 409 would be correct). Both
 * directions mean the unit tests need to cover the edge cases node-
 * postgres does and does not produce, not just a happy path.
 */
import { describe, expect, it } from 'vitest';

import {
  PG_UNIQUE_VIOLATION,
  detectUniqueViolation,
  runOrCatchUnique,
} from '@/lib/db/unique-violation';

/* -------------------------------------------------------------------------- */
/*  Builders                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build an object shaped like the `DatabaseError` node-postgres raises
 * on a unique-index collision. We construct a plain object rather than
 * importing `pg.DatabaseError` to keep the test suite dependency-free
 * and stable across driver upgrades — the helper already inspects by
 * duck-typing, so a plain object faithfully represents the runtime
 * shape it will see.
 */
interface UniqueErrorOverrides {
  readonly constraint?: string | undefined;
  readonly constraint_name?: string | undefined;
  readonly detail?: string | undefined;
  readonly code?: string;
  /** Pass `true` to explicitly leave `constraint` unset on the error object. */
  readonly omitConstraint?: boolean;
}

function uniqueError(overrides: UniqueErrorOverrides = {}): Error & Record<string, unknown> {
  const err = new Error('duplicate key value violates unique constraint') as Error &
    Record<string, unknown>;
  err['code'] = overrides.code ?? PG_UNIQUE_VIOLATION;
  // Default behavior: if no `constraint` / `constraint_name` override is
  // supplied and the caller did not explicitly opt out, include a
  // plausible constraint name so the error looks like the real thing.
  // Empty string is a valid test input (exercises the empty-name guard).
  if (overrides.omitConstraint !== true) {
    if (overrides.constraint !== undefined) {
      err['constraint'] = overrides.constraint;
    } else if (overrides.constraint_name === undefined) {
      err['constraint'] = 'customers_email_key';
    }
  }
  if (overrides.constraint_name !== undefined) {
    err['constraint_name'] = overrides.constraint_name;
  }
  if (overrides.detail !== undefined) {
    err['detail'] = overrides.detail;
  }
  return err;
}

/* -------------------------------------------------------------------------- */
/*  detectUniqueViolation                                                      */
/* -------------------------------------------------------------------------- */

describe('db/unique-violation', () => {
  describe('detectUniqueViolation', () => {
    it('recognises a standard node-postgres unique-violation', () => {
      const err = uniqueError({
        constraint: 'customers_email_key',
        detail: 'Key (lower(email))=(x@y) already exists.',
      });

      const got = detectUniqueViolation(err);

      expect(got).toEqual({
        constraint: 'customers_email_key',
        detail: 'Key (lower(email))=(x@y) already exists.',
      });
    });

    it('accepts `constraint_name` as an alternate spelling', () => {
      // Some drivers (notably pg-cursor + certain ORMs) expose the
      // constraint under `constraint_name` instead of `constraint`.
      // Both shapes must resolve to the same struct.
      const err = uniqueError({ constraint_name: 'phone_unique' });

      const got = detectUniqueViolation(err);

      expect(got).toEqual({ constraint: 'phone_unique', detail: undefined });
    });

    it('returns null for a non-23505 SQLSTATE (check-constraint, not-null, etc.)', () => {
      // 23503 = foreign-key violation, still an integrity-class error
      // but NOT a unique-index collision — surfacing it as "email
      // already taken" would lie to the user.
      const err = uniqueError({ constraint: 'customers_email_key', code: '23503' });

      expect(detectUniqueViolation(err)).toBeNull();
    });

    it('returns null when code is not a Postgres SQLSTATE', () => {
      const err = new Error('boom') as Error & Record<string, unknown>;
      err['code'] = 'ECONNREFUSED';
      err['constraint'] = 'customers_email_key';

      expect(detectUniqueViolation(err)).toBeNull();
    });

    it('returns null when 23505 fires with no constraint name', () => {
      // Postgres always populates the constraint for a unique-violation;
      // if we see the SQLSTATE but lack the name, a wrapping layer has
      // stripped metadata and we must not classify blindly.
      const err = uniqueError({ omitConstraint: true });

      expect(detectUniqueViolation(err)).toBeNull();
    });

    it('returns null for null / undefined / primitive error values', () => {
      expect(detectUniqueViolation(null)).toBeNull();
      expect(detectUniqueViolation(undefined)).toBeNull();
      expect(detectUniqueViolation('boom')).toBeNull();
      expect(detectUniqueViolation(0)).toBeNull();
      expect(detectUniqueViolation({})).toBeNull();
    });

    it('returns null when constraint is an empty string', () => {
      const err = uniqueError({ constraint: '' });

      expect(detectUniqueViolation(err)).toBeNull();
    });

    it('prefers `constraint` over `constraint_name` when both exist', () => {
      // If a driver populates both (e.g. a wrapper layer adds a mirror),
      // take the canonical field — they should never disagree in
      // practice, but the contract needs to be deterministic.
      const err = uniqueError({
        constraint: 'canonical_key',
        constraint_name: 'mirror_key',
      });

      const got = detectUniqueViolation(err);

      expect(got?.constraint).toBe('canonical_key');
    });

    it('drops a non-string detail rather than passing through garbage', () => {
      // `detail` is documented as a human-readable string; if a driver
      // ever hands us a number or object, we return `undefined` so
      // consumers don't serialize it into an error message.
      const err = uniqueError({ constraint: 'customers_email_key' });
      // Deliberately wrong type at runtime to exercise the typeof guard.
      (err as Record<string, unknown>)['detail'] = 42;

      expect(detectUniqueViolation(err)?.detail).toBeUndefined();
    });

    /* ---------------------------------------------------------------- */
    /*  F-A5-BURN-001 — Drizzle [cause] chain unwrap                    */
    /* ---------------------------------------------------------------- */

    it('walks `cause` once to reach the pg error inside a Drizzle wrapper', () => {
      // Drizzle wraps every failed query in a top-level Error
      // (`Failed query: …`) whose `code` / `constraint` are undefined;
      // the actual node-postgres error lives in `[cause]`. Pre-fix
      // F-A5-BURN-001 (P5 audit), the detector returned null for this
      // shape and `runOrCatchUnique` re-threw legitimate replays as
      // 500. The fix walks the cause chain.
      const pgErr = uniqueError({
        constraint: 'oauth_state_used_pkey',
        detail: 'Key (jti)=(abc) already exists.',
      });
      const drizzleWrap = new Error(
        'Failed query: INSERT INTO oauth_state_used (...)',
      ) as Error & { cause?: unknown };
      drizzleWrap.cause = pgErr;

      const got = detectUniqueViolation(drizzleWrap);

      expect(got).toEqual({
        constraint: 'oauth_state_used_pkey',
        detail: 'Key (jti)=(abc) already exists.',
      });
    });

    it('walks multiple `cause` levels for doubly-wrapped errors', () => {
      // Some pool drivers add their own wrap layer — depth-2 is the
      // tightest realistic shape (driver pool → Drizzle → pg). The
      // detector tolerates it without forcing each layer to fix its
      // own wrapping.
      const pgErr = uniqueError({ constraint: 'customers_email_key' });
      const middle = new Error('pool query failed') as Error & { cause?: unknown };
      middle.cause = pgErr;
      const outer = new Error('Failed query: …') as Error & { cause?: unknown };
      outer.cause = middle;

      expect(detectUniqueViolation(outer)?.constraint).toBe('customers_email_key');
    });

    it('returns null when the cause chain never holds a 23505', () => {
      // A wrapped non-unique error must NOT be classified as a
      // unique-violation just because the wrapper has no `code` field.
      const innerFkErr = new Error('FK violation') as Error & Record<string, unknown>;
      innerFkErr['code'] = '23503';
      innerFkErr['constraint'] = 'customers_firm_id_fkey';
      const wrap = new Error('Failed query: …') as Error & { cause?: unknown };
      wrap.cause = innerFkErr;

      expect(detectUniqueViolation(wrap)).toBeNull();
    });

    it('caps the cause walk at depth 4 to defend against pathological chains', () => {
      // Build a 6-deep chain whose only 23505 is at the bottom — the
      // walker should stop before reaching it. Outcome: null. Bound
      // is defensive (a real driver stack is 1-2 levels); the cap
      // costs nothing legitimate and prevents an attacker-controlled
      // chain from forcing arbitrary work.
      const deepest = uniqueError({ constraint: 'customers_email_key' });
      let current: Error & { cause?: unknown } = deepest;
      for (let i = 0; i < 5; i++) {
        const wrap = new Error(`wrap-${i}`) as Error & { cause?: unknown };
        wrap.cause = current;
        current = wrap;
      }

      expect(detectUniqueViolation(current)).toBeNull();
    });
  });

  /* ------------------------------------------------------------------------ */
  /*  runOrCatchUnique                                                         */
  /* ------------------------------------------------------------------------ */

  describe('runOrCatchUnique', () => {
    it('returns {status: ok, value} when the op succeeds', async () => {
      const result = await runOrCatchUnique(
        async () => ({ rowsAffected: 1 }),
        ['customers_email_key'],
      );

      expect(result).toEqual({ status: 'ok', value: { rowsAffected: 1 } });
    });

    it('converts a whitelisted 23505 into {status: violation, constraint}', async () => {
      const err = uniqueError({
        constraint: 'customers_email_key',
        detail: 'Key (lower(email))=(x@y) already exists.',
      });

      const result = await runOrCatchUnique(
        async () => {
          throw err;
        },
        ['customers_email_key'],
      );

      expect(result).toEqual({
        status: 'violation',
        constraint: 'customers_email_key',
        detail: 'Key (lower(email))=(x@y) already exists.',
      });
    });

    it('re-throws a 23505 for a constraint NOT in the whitelist', async () => {
      // Whitelist only emails but we hit a phone collision — surfacing
      // this as "email taken" would mislead the user and mask a real
      // race; the helper must let it bubble up.
      const err = uniqueError({ constraint: 'customers_phone_key' });

      await expect(
        runOrCatchUnique(
          async () => {
            throw err;
          },
          ['customers_email_key'],
        ),
      ).rejects.toBe(err);
    });

    it('re-throws a non-23505 error unchanged', async () => {
      const err = new Error('connection lost');

      await expect(
        runOrCatchUnique(
          async () => {
            throw err;
          },
          ['customers_email_key'],
        ),
      ).rejects.toBe(err);
    });

    it('handles multiple whitelisted constraints — returns the matched one', async () => {
      // Real callers often accept any of several collisions (e.g.
      // email OR phone) and need to know which fired to decide the
      // user-facing message.
      const err = uniqueError({ constraint: 'customers_phone_key' });

      const result = await runOrCatchUnique(
        async () => {
          throw err;
        },
        ['customers_email_key', 'customers_phone_key'],
      );

      expect(result).toEqual({
        status: 'violation',
        constraint: 'customers_phone_key',
        detail: undefined,
      });
    });

    it('rejects an empty whitelist — every 23505 re-throws', async () => {
      // "Expect no unique violations from this op" is a legitimate
      // assertion — any 23505 means a schema bug the caller wants to
      // see rather than silently masquerade as a 409.
      const err = uniqueError({ constraint: 'customers_email_key' });

      await expect(
        runOrCatchUnique(
          async () => {
            throw err;
          },
          [],
        ),
      ).rejects.toBe(err);
    });

    it('does not swallow a synchronous throw from the op', async () => {
      // Drizzle's `.execute` returns a promise, but pathological
      // callers may throw synchronously inside the op. The helper
      // should still catch it — the `await op()` form converts a sync
      // throw into a rejected promise automatically.
      const err = uniqueError({ constraint: 'customers_email_key' });

      const result = await runOrCatchUnique<never>(
        // eslint-disable-next-line @typescript-eslint/require-await
        async () => {
          throw err;
        },
        ['customers_email_key'],
      );

      expect(result.status).toBe('violation');
    });
  });
});
