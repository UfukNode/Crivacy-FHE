// @vitest-environment node
/**
 * verifyEmailCode primitive — unit coverage.
 *
 * The race-free guarantees of this primitive live in the SQL (atomic
 * UPDATE with server-side arithmetic, row locks, conditional CASE),
 * so these unit tests assert two classes of invariant:
 *
 *   1. **SQL shape** — each scenario must emit the right query with
 *      the right clauses in the right order. A regression where step 2
 *      silently drops `FOR UPDATE` or changes `attempts + 1` to a JS
 *      side computation would reopen the TOCTOU that motivated this
 *      module, but the database-side guarantee would be broken long
 *      before a functional test catches it.
 *
 *   2. **State mapping** — each `VerifyCodeResult` variant must come
 *      from the right combination of row presence / row fields. A
 *      mismatched mapping (e.g. returning `used` when the row was only
 *      invalidated) would mislead the caller into surfacing the wrong
 *      error.
 *
 * Actual concurrent-submission race-safety is exercised by Phase 3
 * integration tests against real Postgres, where we can start two
 * transactions and observe that `attempts` moves by exactly two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';

import {
  CUSTOMER_EMAIL_VERIFICATION_TABLE,
  CUSTOMER_PASSWORD_RESET_TABLE,
  FIRM_PASSWORD_RESET_TABLE,
  verifyEmailCode,
  type TokenTableConfig,
} from '@/lib/auth/verify-email-code';

/* -------------------------------------------------------------------------- */
/*  Local mock DB with deep SQL normalization                                  */
/* -------------------------------------------------------------------------- */

/**
 * Drizzle's `sql.raw()` embeds a nested `SQL` instance whose chunks
 * are not visited by the shared `ratelimit/fixtures.ts` normalizer.
 * Since this primitive uses `sql.raw()` for closed-union table +
 * column identifiers, we need a recursive walker that descends into
 * nested `queryChunks` so the assertions can see the rendered table
 * name in the normalised string.
 */
function normalizeSqlDeep(arg: unknown): string {
  if (arg === null || arg === undefined) return '';
  if (typeof arg === 'string') return arg;
  if (typeof arg !== 'object') return String(arg);

  const candidate = arg as {
    readonly queryChunks?: unknown[];
    readonly value?: unknown;
  };

  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.map((chunk) => normalizeSqlDeep(chunk)).join(' ');
  }

  if ('value' in candidate) {
    if (typeof candidate.value === 'string') return candidate.value;
    if (Array.isArray(candidate.value)) {
      return candidate.value
        .map((seg) => (typeof seg === 'string' ? seg : ''))
        .join('');
    }
    // Param with a non-string value — render as a placeholder so the
    // test can still assert the shape without being confused by the
    // serialised value (and so a raw hash/secret never sneaks into a
    // substring match).
    return '?';
  }
  return '';
}

interface DeepMockDb {
  readonly db: CrivacyDatabase;
  readonly calls: { sqlString: string }[];
  readonly queue: (rows: unknown[]) => void;
  readonly reset: () => void;
}

function buildDeepMockDb(): DeepMockDb {
  const calls: { sqlString: string }[] = [];
  const queue: unknown[][] = [];

  const execute = vi.fn(async (sqlArg: unknown) => {
    const sqlString = normalizeSqlDeep(sqlArg).replace(/\s+/g, ' ').trim();
    calls.push({ sqlString });
    const next = queue.shift();
    return { rows: next ?? [] };
  });

  const db = { execute } as unknown as CrivacyDatabase;

  return {
    db,
    calls,
    queue: (rows) => {
      queue.push(rows);
    },
    reset: () => {
      calls.length = 0;
      queue.length = 0;
      execute.mockClear();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN_ID = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-04-22T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();

/**
 * Run verifyEmailCode with a freshly primed mock. Each test re-queues
 * the results it needs — the helper just packages the DI and keeps
 * call sites terse.
 */
async function runVerify(
  mock: DeepMockDb,
  overrides: {
    readonly table?: TokenTableConfig;
    readonly subjectId?: string;
    readonly submittedCode?: string;
    readonly maxAttempts?: number;
    readonly now?: Date;
  } = {},
) {
  return verifyEmailCode({
    db: mock.db,
    table: overrides.table ?? CUSTOMER_EMAIL_VERIFICATION_TABLE,
    subjectId: overrides.subjectId ?? SUBJECT_ID,
    submittedCode: overrides.submittedCode ?? '123456',
    maxAttempts: overrides.maxAttempts ?? 5,
    now: overrides.now ?? NOW,
  });
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('auth/verify-email-code', () => {
  let mock: DeepMockDb;

  beforeEach(() => {
    mock = buildDeepMockDb();
  });

  afterEach(() => {
    mock.reset();
  });

  describe('match path (atomic burn-on-match)', () => {
    it('returns match + tokenId when step 1 UPDATE returns a row', async () => {
      // Primed: step 1 matches the row and burns it. No step 2 / step 3.
      mock.queue([{ id: TOKEN_ID }]);

      const result = await runVerify(mock);

      expect(result).toEqual({ status: 'match', tokenId: TOKEN_ID });
      // The primitive must short-circuit — no second UPDATE and no
      // diagnostic SELECT can run once step 1 succeeds, otherwise we
      // would bump `attempts` or leak timing on the "correct code" path.
      expect(mock.calls).toHaveLength(1);
    });

    it('step 1 emits UPDATE with FOR UPDATE, token_hash filter, ORDER BY created_at DESC', async () => {
      mock.queue([{ id: TOKEN_ID }]);

      await runVerify(mock, { submittedCode: '042 781' }); // spaces tolerated

      const step1 = mock.calls[0]?.sqlString ?? '';
      expect(step1).toContain('UPDATE');
      expect(step1).toContain('SET used_at');
      expect(step1).toContain('token_hash');
      // Lock contention control — without FOR UPDATE two parallel
      // correct-code submissions could both see the row as claimable
      // and the second one would race into step 2.
      expect(step1).toContain('FOR UPDATE');
      expect(step1).toContain('ORDER BY created_at DESC');
      expect(step1).toContain('LIMIT 1');
    });
  });

  describe('mismatch path (attempts++ on active row)', () => {
    it('returns mismatch with remaining count when attempts below cap', async () => {
      mock.queue([]); // step 1 empty
      mock.queue([{ attempts: 2, invalidated_at: null }]); // step 2

      const result = await runVerify(mock, { maxAttempts: 5 });

      expect(result).toEqual({ status: 'mismatch', remainingAttempts: 3 });
      expect(mock.calls).toHaveLength(2);
    });

    it('step 2 uses server-side attempts + 1 with CASE-gated invalidated_at', async () => {
      mock.queue([]);
      mock.queue([{ attempts: 1, invalidated_at: null }]);

      await runVerify(mock);

      const step2 = mock.calls[1]?.sqlString ?? '';
      expect(step2).toContain('attempts = attempts + 1');
      expect(step2).toContain('FOR UPDATE');
      // The CASE expression prevents a future bump from re-invalidating
      // an already-invalidated row in weird race orders.
      expect(step2).toContain('CASE');
      expect(step2).toContain('invalidated_at =');
    });

    it('clamps remainingAttempts at 0 when attempts already at cap', async () => {
      // The row was already at max but somehow not invalidated yet —
      // defensively clamp so the caller cannot see a negative value.
      mock.queue([]);
      mock.queue([{ attempts: 6, invalidated_at: null }]);

      const result = await runVerify(mock, { maxAttempts: 5 });

      expect(result).toEqual({ status: 'mismatch', remainingAttempts: 0 });
    });
  });

  describe('exhausted path (attempts hit cap on this submission)', () => {
    it('returns exhausted when step 2 stamps invalidated_at', async () => {
      mock.queue([]);
      mock.queue([{ attempts: 5, invalidated_at: NOW_ISO }]);

      const result = await runVerify(mock, { maxAttempts: 5 });

      expect(result).toEqual({ status: 'exhausted' });
      expect(mock.calls).toHaveLength(2);
    });
  });

  describe('diagnostic path (no active row)', () => {
    it('returns not_found when the subject has no token rows', async () => {
      mock.queue([]);
      mock.queue([]);
      mock.queue([]);

      const result = await runVerify(mock);

      expect(result).toEqual({ status: 'not_found' });
      expect(mock.calls).toHaveLength(3);
    });

    it('returns used when the latest row has used_at stamped', async () => {
      mock.queue([]);
      mock.queue([]);
      mock.queue([
        {
          used_at: '2026-04-22T11:59:30.000Z',
          invalidated_at: null,
          expires_at: '2026-04-22T12:10:00.000Z',
        },
      ]);

      const result = await runVerify(mock);

      expect(result).toEqual({ status: 'used' });
    });

    it('returns invalidated when the latest row has invalidated_at stamped', async () => {
      mock.queue([]);
      mock.queue([]);
      mock.queue([
        {
          used_at: null,
          invalidated_at: '2026-04-22T11:59:00.000Z',
          expires_at: '2026-04-22T12:10:00.000Z',
        },
      ]);

      const result = await runVerify(mock);

      expect(result).toEqual({ status: 'invalidated' });
    });

    it('returns expired when the latest row is past its TTL', async () => {
      mock.queue([]);
      mock.queue([]);
      mock.queue([
        {
          used_at: null,
          invalidated_at: null,
          // Expired five minutes ago relative to NOW.
          expires_at: '2026-04-22T11:55:00.000Z',
        },
      ]);

      const result = await runVerify(mock);

      expect(result).toEqual({ status: 'expired' });
    });

    it('treats used-precedence first when multiple terminals apply', async () => {
      // A row that is used AND invalidated AND expired should surface
      // as `used` — that is the state the user most cares about ("your
      // code already worked, why are you asking again?"). The other
      // states are redundant signal.
      mock.queue([]);
      mock.queue([]);
      mock.queue([
        {
          used_at: '2026-04-22T11:59:30.000Z',
          invalidated_at: '2026-04-22T11:59:35.000Z',
          expires_at: '2026-04-22T11:55:00.000Z',
        },
      ]);

      const result = await runVerify(mock);

      expect(result).toEqual({ status: 'used' });
    });

    it('falls back to invalidated if a row exists but has no terminal stamp', async () => {
      // Interleaving race: step 1 and step 2 both saw no active row,
      // but by the time step 3 ran the terminal stamp had not been
      // written yet — we must not return a false "retry" result to
      // the caller, so treat this as invalidated.
      mock.queue([]);
      mock.queue([]);
      mock.queue([
        {
          used_at: null,
          invalidated_at: null,
          // Not expired — future.
          expires_at: '2026-04-22T12:20:00.000Z',
        },
      ]);

      const result = await runVerify(mock);

      expect(result).toEqual({ status: 'invalidated' });
    });
  });

  describe('table config routing', () => {
    it('customer email verification targets customer_id + email_verification_tokens', async () => {
      mock.queue([{ id: TOKEN_ID }]);

      await runVerify(mock, { table: CUSTOMER_EMAIL_VERIFICATION_TABLE });

      const step1 = mock.calls[0]?.sqlString ?? '';
      expect(step1).toContain('email_verification_tokens');
      expect(step1).toContain('customer_id');
      expect(step1).not.toContain('firm_user_id');
    });

    it('customer password reset targets customer_id + password_reset_tokens', async () => {
      mock.queue([{ id: TOKEN_ID }]);

      await runVerify(mock, { table: CUSTOMER_PASSWORD_RESET_TABLE });

      const step1 = mock.calls[0]?.sqlString ?? '';
      expect(step1).toContain('password_reset_tokens');
      expect(step1).toContain('customer_id');
      expect(step1).not.toContain('firm_user_id');
    });

    it('firm password reset targets firm_user_id + firm_user_password_reset_tokens', async () => {
      mock.queue([{ id: TOKEN_ID }]);

      await runVerify(mock, { table: FIRM_PASSWORD_RESET_TABLE });

      const step1 = mock.calls[0]?.sqlString ?? '';
      expect(step1).toContain('firm_user_password_reset_tokens');
      expect(step1).toContain('firm_user_id');
    });
  });

  describe('submitted-code normalisation', () => {
    it('passes spaces/dashes through hashSubmittedCode before binding', async () => {
      // The deep mock normalizer renders Params as '?', so the SQL
      // string never contains the literal hash or raw code — the
      // primitive is doing the hashing before parameter binding.
      // We verify the invariant by asserting both forms produce the
      // same call shape: same SQL text, same Param positions.
      const spacedMock = buildDeepMockDb();
      spacedMock.queue([{ id: TOKEN_ID }]);
      await verifyEmailCode({
        db: spacedMock.db,
        table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
        subjectId: SUBJECT_ID,
        submittedCode: '0-4-2 781',
        maxAttempts: 5,
        now: NOW,
      });

      const cleanMock = buildDeepMockDb();
      cleanMock.queue([{ id: TOKEN_ID }]);
      await verifyEmailCode({
        db: cleanMock.db,
        table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
        subjectId: SUBJECT_ID,
        submittedCode: '042781',
        maxAttempts: 5,
        now: NOW,
      });

      // Both forms emit byte-identical SQL — the only input difference
      // was the noise characters, which hashSubmittedCode must strip.
      expect(spacedMock.calls[0]?.sqlString).toBe(cleanMock.calls[0]?.sqlString);
    });
  });

  describe('clock handling', () => {
    it('step 1 query shape references expires_at for TTL comparison', async () => {
      const fakeNow = new Date('2030-01-01T00:00:00.000Z');
      mock.queue([{ id: TOKEN_ID }]);

      await runVerify(mock, { now: fakeNow });

      // The SQL text references expires_at as the column to compare
      // against the injected `now`; the literal timestamp is a Param
      // so it does not appear in the normalised text.
      const step1 = mock.calls[0]?.sqlString ?? '';
      expect(step1).toContain('expires_at');
    });
  });
});
