// @vitest-environment node
/**
 * issueShortLivedToken — unit coverage for the one-time-code issue
 * primitive that mirrors verifyEmailCode on the issuance side.
 *
 * The test surface assertions:
 *   1. Every issuance opens a transaction, so invalidate + insert
 *      succeed or fail atomically. A half-committed pair would leave
 *      the previous code invalidated with no fresh row to replace it
 *      — the worst possible UX for a user clicking "resend".
 *   2. `invalidatePrevious` flag drops the UPDATE step when `false`.
 *   3. `supportsIpAddress` routes to the ip-aware INSERT (password
 *      reset tables) or the minimal INSERT (email verification).
 *   4. The raw code returned is the one that was hashed into the DB —
 *      we can't directly reveal the hash from the mock, but we can
 *      verify the code is non-empty 6-digit structure and different
 *      on each call (entropy).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';

import {
  CUSTOMER_EMAIL_VERIFICATION_TABLE,
  CUSTOMER_PASSWORD_RESET_TABLE,
  FIRM_PASSWORD_RESET_TABLE,
} from '@/lib/auth/verify-email-code';
import { issueShortLivedToken } from '@/lib/auth/short-lived-tokens';

/* -------------------------------------------------------------------------- */
/*  Tx-aware mock DB                                                           */
/* -------------------------------------------------------------------------- */

interface TxMock {
  readonly db: CrivacyDatabase;
  readonly executes: { sqlString: string }[];
  readonly transactionOpened: () => boolean;
  readonly reset: () => void;
}

function normalizeSqlDeep(arg: unknown): string {
  if (arg === null || arg === undefined) return '';
  if (typeof arg === 'string') return arg;
  if (typeof arg !== 'object') return String(arg);
  const candidate = arg as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.map((c) => normalizeSqlDeep(c)).join(' ');
  }
  if ('value' in candidate) {
    if (typeof candidate.value === 'string') return candidate.value;
    if (Array.isArray(candidate.value)) {
      return candidate.value.map((s) => (typeof s === 'string' ? s : '')).join('');
    }
    return '?';
  }
  return '';
}

function buildTxMockDb(): TxMock {
  const executes: { sqlString: string }[] = [];
  let txOpened = false;

  const exec = vi.fn(async (sqlArg: unknown) => {
    const sqlString = normalizeSqlDeep(sqlArg).replace(/\s+/g, ' ').trim();
    executes.push({ sqlString });
    return { rows: [] };
  });

  const tx = { execute: exec };

  const transaction = vi.fn(async (cb: (txArg: typeof tx) => Promise<unknown>) => {
    txOpened = true;
    return cb(tx);
  });

  const db = { execute: exec, transaction } as unknown as CrivacyDatabase;

  return {
    db,
    executes,
    transactionOpened: () => txOpened,
    reset: () => {
      executes.length = 0;
      txOpened = false;
      exec.mockClear();
      transaction.mockClear();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-04-22T12:00:00.000Z');
const TTL = 600; // 10 minutes

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('auth/short-lived-tokens — issueShortLivedToken', () => {
  let mock: TxMock;

  beforeEach(() => {
    mock = buildTxMockDb();
  });

  it('opens a transaction and runs UPDATE + INSERT for a table without ip_address', async () => {
    const result = await issueShortLivedToken({
      db: mock.db,
      table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
      subjectId: SUBJECT_ID,
      ttlSeconds: TTL,
      now: NOW,
    });

    expect(mock.transactionOpened()).toBe(true);
    expect(mock.executes).toHaveLength(2);

    const [step1, step2] = mock.executes;
    expect(step1?.sqlString).toContain('UPDATE');
    expect(step1?.sqlString).toContain('email_verification_tokens');
    expect(step1?.sqlString).toContain('SET invalidated_at');
    expect(step1?.sqlString).toContain('used_at IS NULL');

    expect(step2?.sqlString).toContain('INSERT INTO');
    expect(step2?.sqlString).toContain('email_verification_tokens');
    expect(step2?.sqlString).toContain('customer_id');
    expect(step2?.sqlString).toContain('token_hash');
    // Must NOT write ip_address to a non-supporting table.
    expect(step2?.sqlString).not.toContain('ip_address');

    // Return shape — raw code and computed expiry.
    expect(result.rawCode).toMatch(/^\d{6}$/);
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + TTL * 1000);
  });

  it('writes ip_address for tables that support it (customer reset)', async () => {
    await issueShortLivedToken({
      db: mock.db,
      table: CUSTOMER_PASSWORD_RESET_TABLE,
      subjectId: SUBJECT_ID,
      ttlSeconds: TTL,
      ipAddress: '203.0.113.99',
      now: NOW,
    });

    const insert = mock.executes[1]?.sqlString ?? '';
    expect(insert).toContain('password_reset_tokens');
    expect(insert).toContain('customer_id');
    expect(insert).toContain('ip_address');
  });

  it('routes firm password reset to the firm_user table + firm_user_id column', async () => {
    await issueShortLivedToken({
      db: mock.db,
      table: FIRM_PASSWORD_RESET_TABLE,
      subjectId: SUBJECT_ID,
      ttlSeconds: TTL,
      ipAddress: '198.51.100.22',
      now: NOW,
    });

    const update = mock.executes[0]?.sqlString ?? '';
    const insert = mock.executes[1]?.sqlString ?? '';
    expect(update).toContain('firm_user_password_reset_tokens');
    expect(update).toContain('firm_user_id');
    expect(insert).toContain('firm_user_password_reset_tokens');
    expect(insert).toContain('firm_user_id');
    expect(insert).toContain('ip_address');
    // Cross-audience isolation — firm INSERT must not leak customer_id.
    expect(insert).not.toContain('customer_id');
  });

  it('skips the invalidate step when invalidatePrevious is false', async () => {
    await issueShortLivedToken({
      db: mock.db,
      table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
      subjectId: SUBJECT_ID,
      ttlSeconds: TTL,
      invalidatePrevious: false,
      now: NOW,
    });

    expect(mock.executes).toHaveLength(1);
    expect(mock.executes[0]?.sqlString).toContain('INSERT INTO');
    expect(mock.executes[0]?.sqlString).not.toContain('UPDATE');
  });

  it('runs invalidate by default (invalidatePrevious omitted)', async () => {
    await issueShortLivedToken({
      db: mock.db,
      table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
      subjectId: SUBJECT_ID,
      ttlSeconds: TTL,
      now: NOW,
    });

    expect(mock.executes).toHaveLength(2);
    expect(mock.executes[0]?.sqlString).toContain('UPDATE');
    expect(mock.executes[1]?.sqlString).toContain('INSERT INTO');
  });

  it('computes expiresAt from the injected now clock', async () => {
    const fakeNow = new Date('2030-01-01T00:00:00.000Z');

    const result = await issueShortLivedToken({
      db: mock.db,
      table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
      subjectId: SUBJECT_ID,
      ttlSeconds: 30,
      now: fakeNow,
    });

    expect(result.expiresAt.toISOString()).toBe('2030-01-01T00:00:30.000Z');
  });

  it('emits a fresh raw code on every call (entropy sanity)', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      mock.reset();
      const { rawCode } = await issueShortLivedToken({
        db: mock.db,
        table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
        subjectId: SUBJECT_ID,
        ttlSeconds: TTL,
        now: NOW,
      });
      codes.add(rawCode);
    }

    // A 6-digit code has 10^6 possible values; 10 draws collide with
    // probability ~45e-6 — effectively never in a healthy generator.
    // Seeing the set size drop below the draw count implies the RNG
    // is broken (seeded, low-entropy, etc.) and is worth failing on.
    expect(codes.size).toBe(10);
  });
});
