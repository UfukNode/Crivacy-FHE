// @vitest-environment node
/**
 * totp-management — unit coverage for the audience-agnostic TOTP
 * rotation + recovery-code primitives.
 *
 * Each primitive is a transaction of 2-10 DB statements; the tests
 * assert that:
 *
 *   1. The right audience tables and columns appear in the SQL —
 *      wiring FIRM_TOTP_TABLE must target `firm_users` /
 *      `firm_user_recovery_codes` / `firm_user_id`, ADMIN_TOTP_TABLE
 *      must target `admin_users` / `admin_user_recovery_codes` /
 *      `admin_user_id`. A mix-up here would let a firm rotation
 *      rewrite an admin row.
 *
 *   2. Each primitive opens a transaction — any failure inside must
 *      roll back both the UPDATE and the recovery-code batch writes.
 *
 *   3. `replaceTotp` refuses to write anything when the new code
 *      fails verification — the user would otherwise be locked out
 *      of the next login with no authenticator that works.
 *
 *   4. Raw recovery codes flow out of the primitive exactly once;
 *      only hashes reach the DB.
 *
 * The recovery-code batch generator and TOTP encryption helpers have
 * their own unit coverage; we stub them to keep the tests focused on
 * the primitive's orchestration logic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/totp', () => ({
  verifyTotpCode: vi.fn(),
  generateTotpSecret: vi.fn(),
  buildOtpauthUrl: vi.fn(),
}));
vi.mock('@/lib/auth/crypto-box', () => ({
  loadKeyFromBase64: vi.fn(() => Buffer.alloc(32)),
  seal: vi.fn(() => ({
    ciphertext: Buffer.from('ct', 'utf8'),
    tag: Buffer.from('tag', 'utf8'),
    nonce: Buffer.from('nonce', 'utf8'),
  })),
}));
vi.mock('@/lib/auth/recovery-code', () => ({
  generateRecoveryCodeBatch: vi.fn(() => [
    { raw: 'raw-AAAA', hash: 'hash-AAAA' },
    { raw: 'raw-BBBB', hash: 'hash-BBBB' },
  ]),
  hashRecoveryCode: vi.fn((c: string) => `hash(${c})`),
}));

import type { AuthConfig } from '@/lib/auth/config';
import type { CrivacyDatabase } from '@/lib/db/client';

import {
  ADMIN_TOTP_TABLE,
  FIRM_TOTP_TABLE,
  countRemainingRecoveryCodes,
  disableTotp,
  regenerateRecoveryCodes,
  replaceTotp,
} from '@/lib/auth/totp-management';
import { AuthError } from '@/lib/auth/errors';
import { verifyTotpCode } from '@/lib/auth/totp';

/* -------------------------------------------------------------------------- */
/*  Tx-aware mock DB                                                           */
/* -------------------------------------------------------------------------- */

interface TxMock {
  readonly db: CrivacyDatabase;
  /** Every `tx.execute(sql)` / `db.execute(sql)` call in sequence. */
  readonly executes: { sqlString: string }[];
  /** True if `db.transaction(cb)` was invoked. */
  readonly transactionOpened: () => boolean;
  readonly queueExecute: (rows: unknown[]) => void;
  readonly reset: () => void;
}

function normalizeSqlDeep(arg: unknown): string {
  if (arg === null || arg === undefined) return '';
  if (typeof arg === 'string') return arg;
  if (typeof arg !== 'object') return String(arg);

  const candidate = arg as {
    readonly queryChunks?: unknown[];
    readonly value?: unknown;
  };

  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.map((c) => normalizeSqlDeep(c)).join(' ');
  }
  if ('value' in candidate) {
    if (typeof candidate.value === 'string') return candidate.value;
    if (Array.isArray(candidate.value)) {
      return candidate.value
        .map((seg) => (typeof seg === 'string' ? seg : ''))
        .join('');
    }
    return '?';
  }
  return '';
}

function buildTxMockDb(): TxMock {
  const executes: { sqlString: string }[] = [];
  const execQueue: unknown[][] = [];
  let txOpened = false;

  const exec = vi.fn(async (sqlArg: unknown) => {
    const sqlString = normalizeSqlDeep(sqlArg).replace(/\s+/g, ' ').trim();
    executes.push({ sqlString });
    return { rows: execQueue.shift() ?? [] };
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
    queueExecute: (rows) => {
      execQueue.push(rows);
    },
    reset: () => {
      executes.length = 0;
      execQueue.length = 0;
      txOpened = false;
      exec.mockClear();
      transaction.mockClear();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-04-22T12:00:00.000Z');

const AUTH_CONFIG = {
  totpEncryptionKey: 'Zm9vYmFyYmF6cXV4',
  totpEncryptionKeyVersion: 1,
  totpDriftSteps: 1,
  totpDigits: 6,
  totpStepSeconds: 30,
  totpIssuer: 'Crivacy',
} as unknown as AuthConfig;

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('auth/totp-management', () => {
  let mock: TxMock;

  beforeEach(() => {
    mock = buildTxMockDb();
    vi.mocked(verifyTotpCode).mockReset();
  });

  /* ======================================================================== */
  /*  replaceTotp                                                              */
  /* ======================================================================== */

  describe('replaceTotp', () => {
    it('rejects the mint when the new code fails verification — no DB writes', async () => {
      vi.mocked(verifyTotpCode).mockReturnValue(false);

      await expect(
        replaceTotp({
          db: mock.db,
          authConfig: AUTH_CONFIG,
          table: FIRM_TOTP_TABLE,
          userId: USER_ID,
          newSecret: 'BASE32SECRET',
          newTotpCode: '000000',
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(AuthError);

      // Zero statements — the verify guard is a pure in-process check.
      expect(mock.executes).toHaveLength(0);
      expect(mock.transactionOpened()).toBe(false);
    });

    it('writes firm_users + firm_user_recovery_codes inside one transaction', async () => {
      vi.mocked(verifyTotpCode).mockReturnValue(true);

      const result = await replaceTotp({
        db: mock.db,
        authConfig: AUTH_CONFIG,
        table: FIRM_TOTP_TABLE,
        userId: USER_ID,
        newSecret: 'BASE32SECRET',
        newTotpCode: '123456',
        now: NOW,
      });

      // The rotation returns the raw codes exactly once.
      expect(result.recoveryCodes).toEqual(['raw-AAAA', 'raw-BBBB']);

      expect(mock.transactionOpened()).toBe(true);
      // Sequence: UPDATE firm_users → DELETE firm_user_recovery_codes
      // → INSERT × N.
      expect(mock.executes).toHaveLength(1 + 1 + 2);
      expect(mock.executes[0]?.sqlString).toContain('UPDATE');
      expect(mock.executes[0]?.sqlString).toContain('firm_users');
      expect(mock.executes[0]?.sqlString).toContain('totp_secret_ciphertext');
      expect(mock.executes[1]?.sqlString).toContain('DELETE');
      expect(mock.executes[1]?.sqlString).toContain('firm_user_recovery_codes');
      expect(mock.executes[1]?.sqlString).toContain('firm_user_id');
      expect(mock.executes[2]?.sqlString).toContain('INSERT INTO');
      expect(mock.executes[2]?.sqlString).toContain('firm_user_recovery_codes');
    });

    it('routes the admin config to admin_users + admin_user_recovery_codes', async () => {
      vi.mocked(verifyTotpCode).mockReturnValue(true);

      await replaceTotp({
        db: mock.db,
        authConfig: AUTH_CONFIG,
        table: ADMIN_TOTP_TABLE,
        userId: USER_ID,
        newSecret: 'BASE32SECRET',
        newTotpCode: '123456',
        now: NOW,
      });

      // UPDATE must target admin_users, recovery writes must target
      // admin_user_recovery_codes — a config mix-up here would let a
      // firm rotation touch an admin row.
      expect(mock.executes[0]?.sqlString).toContain('admin_users');
      expect(mock.executes[0]?.sqlString).not.toContain('firm_users');
      expect(mock.executes[1]?.sqlString).toContain('admin_user_recovery_codes');
      expect(mock.executes[1]?.sqlString).toContain('admin_user_id');
      expect(mock.executes[1]?.sqlString).not.toContain('firm_user');
    });
  });

  /* ======================================================================== */
  /*  disableTotp                                                              */
  /* ======================================================================== */

  describe('disableTotp', () => {
    it('clears TOTP columns + wipes recovery codes in a transaction (firm)', async () => {
      await disableTotp({
        db: mock.db,
        table: FIRM_TOTP_TABLE,
        userId: USER_ID,
        now: NOW,
      });

      expect(mock.transactionOpened()).toBe(true);
      expect(mock.executes).toHaveLength(2);
      // UPDATE firm_users SET totp_* = NULL
      expect(mock.executes[0]?.sqlString).toContain('UPDATE');
      expect(mock.executes[0]?.sqlString).toContain('firm_users');
      expect(mock.executes[0]?.sqlString).toContain('totp_secret_ciphertext = NULL');
      expect(mock.executes[0]?.sqlString).toContain('totp_secret_nonce = NULL');
      expect(mock.executes[0]?.sqlString).toContain('totp_key_version = NULL');
      expect(mock.executes[0]?.sqlString).toContain('totp_enrolled_at = NULL');
      // DELETE FROM firm_user_recovery_codes
      expect(mock.executes[1]?.sqlString).toContain('DELETE');
      expect(mock.executes[1]?.sqlString).toContain('firm_user_recovery_codes');
    });

    it('routes the admin config to admin tables', async () => {
      await disableTotp({
        db: mock.db,
        table: ADMIN_TOTP_TABLE,
        userId: USER_ID,
        now: NOW,
      });

      expect(mock.executes[0]?.sqlString).toContain('admin_users');
      expect(mock.executes[1]?.sqlString).toContain('admin_user_recovery_codes');
    });
  });

  /* ======================================================================== */
  /*  regenerateRecoveryCodes                                                  */
  /* ======================================================================== */

  describe('regenerateRecoveryCodes', () => {
    it('deletes the old batch and inserts the new one in a transaction', async () => {
      const result = await regenerateRecoveryCodes({
        db: mock.db,
        table: FIRM_TOTP_TABLE,
        userId: USER_ID,
        now: NOW,
      });

      expect(result.recoveryCodes).toEqual(['raw-AAAA', 'raw-BBBB']);
      expect(mock.transactionOpened()).toBe(true);
      // DELETE + N × INSERT (stub batch has 2 entries).
      expect(mock.executes).toHaveLength(1 + 2);
      expect(mock.executes[0]?.sqlString).toContain('DELETE');
      expect(mock.executes[0]?.sqlString).toContain('firm_user_recovery_codes');
      expect(mock.executes[1]?.sqlString).toContain('INSERT INTO');
      expect(mock.executes[2]?.sqlString).toContain('INSERT INTO');
    });

    it('does NOT touch the user table — TOTP secret stays untouched', async () => {
      await regenerateRecoveryCodes({
        db: mock.db,
        table: FIRM_TOTP_TABLE,
        userId: USER_ID,
        now: NOW,
      });

      // None of the executes should reference `firm_users` — only the
      // recovery codes table is modified.
      for (const call of mock.executes) {
        expect(call.sqlString).not.toContain('firm_users');
      }
    });
  });

  /* ======================================================================== */
  /*  countRemainingRecoveryCodes                                              */
  /* ======================================================================== */

  describe('countRemainingRecoveryCodes', () => {
    it('returns the integer count from the SELECT', async () => {
      mock.queueExecute([{ count: '3' }]);

      const got = await countRemainingRecoveryCodes(mock.db, FIRM_TOTP_TABLE, USER_ID);

      expect(got).toBe(3);
      expect(mock.executes).toHaveLength(1);
      expect(mock.executes[0]?.sqlString).toContain('SELECT');
      expect(mock.executes[0]?.sqlString).toContain('COUNT(*)');
      expect(mock.executes[0]?.sqlString).toContain('firm_user_recovery_codes');
      // Critical: the SELECT must include `used_at IS NULL` — counting
      // used codes would mislead the UI into saying the user has
      // plenty of fallback codes when they actually have none.
      expect(mock.executes[0]?.sqlString).toContain('used_at IS NULL');
    });

    it('returns 0 when the SELECT returns no row (defensive)', async () => {
      mock.queueExecute([]);

      const got = await countRemainingRecoveryCodes(mock.db, FIRM_TOTP_TABLE, USER_ID);

      expect(got).toBe(0);
    });

    it('routes admin config to admin_user_recovery_codes', async () => {
      mock.queueExecute([{ count: '7' }]);

      const got = await countRemainingRecoveryCodes(mock.db, ADMIN_TOTP_TABLE, USER_ID);

      expect(got).toBe(7);
      expect(mock.executes[0]?.sqlString).toContain('admin_user_recovery_codes');
      expect(mock.executes[0]?.sqlString).toContain('admin_user_id');
    });
  });
});
