// @vitest-environment node
/**
 * reauthGate — unit coverage for the step-up reauthentication primitive.
 *
 * The primitive composes four leaf helpers (verifyPassword,
 * verifyTotpCode, decryptTotpSecret, chain-wallet + linked-accounts),
 * so this suite mocks each at its module boundary and exercises the
 * *integration* between them: which branch runs for which
 * subject × factor pair, which failure reasons surface in which order,
 * and which helpers are (not) invoked along the way.
 *
 * The leaf helpers have their own unit coverage (password.test.ts,
 * totp.test.ts, recovery-code.test.ts, etc.), so we deliberately do
 * not re-prove their correctness here — we just assert reauthGate
 * calls them with the right arguments and interprets their results
 * correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// All imports go through the real module paths; vi.mock below replaces
// the helpers with stubs BEFORE the subject under test loads.
vi.mock('@/lib/auth/password', () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
  passwordNeedsRehash: vi.fn(),
  parseArgon2Header: vi.fn(),
}));
vi.mock('@/lib/auth/totp', () => ({
  verifyTotpCode: vi.fn(),
  verifyAndConsumeTotpCode: vi.fn(),
  generateTotpSecret: vi.fn(),
  buildOtpauthUrl: vi.fn(),
}));
vi.mock('@/lib/auth/decrypt-totp', () => ({
  decryptTotpSecret: vi.fn(),
}));
vi.mock('@/lib/auth/recovery-code', () => ({
  hashRecoveryCode: vi.fn((code: string) => `hash(${code})`),
  generateRecoveryCodeBatch: vi.fn(),
}));
vi.mock('@/lib/customer/evm-wallet', () => ({
  claimWalletNonce: vi.fn(),
  verifyWalletChallenge: vi.fn(),
  verifyEvmWalletSignature: vi.fn(),
}));
vi.mock('@/lib/customer/linked-accounts', () => ({
  findLinkedAccount: vi.fn(),
}));

import type { AuthConfig } from '@/lib/auth/config';
import type { CrivacyDatabase } from '@/lib/db/client';

import { reauthGate, type ReauthFactor, type ReauthSubjectKind } from '@/lib/auth/reauth';
import { verifyPassword } from '@/lib/auth/password';
import { verifyAndConsumeTotpCode, verifyTotpCode } from '@/lib/auth/totp';
import { decryptTotpSecret } from '@/lib/auth/decrypt-totp';
import {
  claimWalletNonce,
  verifyEvmWalletSignature,
  verifyWalletChallenge,
} from '@/lib/customer/evm-wallet';
import { findLinkedAccount } from '@/lib/customer/linked-accounts';

/* -------------------------------------------------------------------------- */
/*  Mock DB                                                                    */
/* -------------------------------------------------------------------------- */

interface MockDb {
  readonly db: CrivacyDatabase;
  /** Queue a row-set for the NEXT `.select().from().where().limit()`. */
  readonly queueSelect: (rows: unknown[]) => void;
  /** Queue a row-set for the NEXT `db.execute(sql)`. */
  readonly queueExecute: (rows: unknown[]) => void;
  /** Inspect all db.execute calls (latest first). */
  readonly executeCalls: () => { sqlString: string }[];
}

/**
 * Build a minimal fake database that answers both the Drizzle query-
 * builder flow (`select().from().where().limit()`) and the raw-SQL
 * flow (`db.execute(sql\`...\`)`). Each call dequeues a pre-queued
 * row-set; no call-arg matching, so the test controls ordering.
 */
function buildMockDb(): MockDb {
  const selectQueue: unknown[][] = [];
  const executeQueue: unknown[][] = [];
  const execCalls: { sqlString: string }[] = [];

  const chain: {
    from: (...args: unknown[]) => typeof chain;
    where: (...args: unknown[]) => typeof chain;
    limit: (n: number) => Promise<unknown[]>;
  } = {
    from: () => chain,
    where: () => chain,
    limit: async () => selectQueue.shift() ?? [],
  };

  const execute = vi.fn(async (sqlArg: unknown) => {
    const queryChunks =
      sqlArg !== null && typeof sqlArg === 'object' && 'queryChunks' in sqlArg
        ? (sqlArg as { queryChunks: unknown[] }).queryChunks
        : [];
    const sqlString = queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (chunk !== null && typeof chunk === 'object' && 'value' in chunk) {
          const val = (chunk as { value: unknown }).value;
          if (typeof val === 'string') return val;
          if (Array.isArray(val)) return val.filter((s) => typeof s === 'string').join('');
        }
        return '';
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    execCalls.push({ sqlString });
    const rows = executeQueue.shift() ?? [];
    return { rows };
  });

  const db = {
    select: vi.fn(() => chain),
    execute,
  } as unknown as CrivacyDatabase;

  return {
    db,
    queueSelect: (rows) => {
      selectQueue.push(rows);
    },
    queueExecute: (rows) => {
      executeQueue.push(rows);
    },
    executeCalls: () => execCalls.slice(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-04-22T12:00:00.000Z');

const AUTH_CONFIG = {
  jwtSecret: 'jwt-secret-xxx',
  totpEncryptionKey: 'enc-key-xxx',
  totpDriftSteps: 1,
  totpDigits: 6,
  totpStepSeconds: 30,
  totpIssuer: 'Crivacy',
} as unknown as AuthConfig;

/**
 * Shape matches what `db.select(...).from(customers/firm_users/admin_users).where(...).limit(1)`
 * resolves to. Each test queues whichever columns its branch reads.
 */
/**
 * Row-builders use explicit `'key' in overrides` checks rather than
 * nullish-coalescing so a caller can pass `{ passwordHash: null }` to
 * model an unset hash — `null ?? default` would silently revert that
 * intent back to the default string.
 */
function customerRow(overrides: { passwordHash?: string | null } = {}): Record<string, unknown> {
  return {
    id: SUBJECT_ID,
    passwordHash:
      'passwordHash' in overrides ? overrides.passwordHash : '$argon2id$fakehash$xxx',
  };
}

function firmRow(
  overrides: {
    passwordHash?: string | null;
    totpEnrolled?: boolean;
  } = {},
): Record<string, unknown> {
  const enrolled = overrides.totpEnrolled ?? true;
  return {
    id: SUBJECT_ID,
    passwordHash:
      'passwordHash' in overrides ? overrides.passwordHash : '$argon2id$fakehash$xxx',
    totpSecretCiphertext: enrolled ? 'ct-xxx' : null,
    totpSecretNonce: enrolled ? 'nonce-xxx' : null,
    totpKeyVersion: enrolled ? 1 : null,
    totpEnrolledAt: enrolled ? NOW : null,
  };
}

function adminRow(
  overrides: {
    passwordHash?: string | null;
    totpEnrolled?: boolean;
  } = {},
): Record<string, unknown> {
  const enrolled = overrides.totpEnrolled ?? true;
  return {
    id: SUBJECT_ID,
    passwordHash:
      'passwordHash' in overrides ? overrides.passwordHash : '$argon2id$fakehash$xxx',
    totpSecretCiphertext: enrolled ? 'ct-xxx' : null,
    totpSecretNonce: enrolled ? 'nonce-xxx' : null,
    totpKeyVersion: enrolled ? 1 : null,
    totpEnrolledAt: enrolled ? NOW : null,
  };
}

const WALLET_ADDRESS = '0x1111111111111111111111111111111111111111';
const WALLET_FACTOR: Extract<ReauthFactor, { type: 'wallet' }> = {
  type: 'wallet',
  challenge: 'challenge-jwt',
  message: 'crivacy.io wants you to sign in…\nNonce: nonce-xxx',
  signature: '0xdeadbeef',
};

const NONCE = 'deadbeefcafebabe';

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('auth/reauth — reauthGate', () => {
  let mock: MockDb;

  beforeEach(() => {
    mock = buildMockDb();
    vi.mocked(verifyPassword).mockReset();
    vi.mocked(verifyTotpCode).mockReset();
    vi.mocked(verifyAndConsumeTotpCode).mockReset();
    vi.mocked(decryptTotpSecret).mockReset();
    vi.mocked(verifyWalletChallenge).mockReset();
    vi.mocked(verifyEvmWalletSignature).mockReset();
    vi.mocked(claimWalletNonce).mockReset();
    vi.mocked(findLinkedAccount).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ======================================================================== */
  /*  Password step                                                            */
  /* ======================================================================== */

  describe('password step (shared across all subjects)', () => {
    const SUBJECTS: readonly ReauthSubjectKind[] = ['customer', 'firm', 'admin'];

    for (const kind of SUBJECTS) {
      it(`returns password_not_set when ${kind}'s password_hash is null`, async () => {
        const row =
          kind === 'customer'
            ? customerRow({ passwordHash: null })
            : kind === 'firm'
              ? firmRow({ passwordHash: null })
              : adminRow({ passwordHash: null });
        mock.queueSelect([row]);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind, id: SUBJECT_ID },
          password: 'any',
          factor: { type: 'none' },
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'password_not_set' });
        // Short-circuit: verifyPassword must never run when the hash is
        // null — otherwise we'd leak "this account has no password"
        // through timing or log output.
        expect(verifyPassword).not.toHaveBeenCalled();
      });

      it(`returns password_not_set for ${kind} when the subject row doesn't exist`, async () => {
        mock.queueSelect([]); // unknown subject id

        const result = await reauthGate({
          db: mock.db,
          subject: { kind, id: SUBJECT_ID },
          password: 'any',
          factor: { type: 'none' },
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'password_not_set' });
      });

      it(`returns wrong_password for ${kind} on a hash mismatch`, async () => {
        const row =
          kind === 'customer' ? customerRow() : kind === 'firm' ? firmRow() : adminRow();
        mock.queueSelect([row]);
        vi.mocked(verifyPassword).mockResolvedValue(false);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind, id: SUBJECT_ID },
          password: 'wrong',
          factor: { type: 'none' },
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'wrong_password' });
        expect(verifyPassword).toHaveBeenCalledWith('wrong', expect.any(String));
      });
    }
  });

  /* ======================================================================== */
  /*  Customer branch                                                          */
  /* ======================================================================== */

  describe('customer branch', () => {
    beforeEach(() => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
    });

    it('returns ok with factor=none when password matches', async () => {
      mock.queueSelect([customerRow()]);

      const result = await reauthGate({
        db: mock.db,
        subject: { kind: 'customer', id: SUBJECT_ID },
        password: 'right',
        factor: { type: 'none' },
        now: NOW,
        authConfig: AUTH_CONFIG,
      });

      expect(result).toMatchObject({ status: 'ok' });
    });

    it('returns factor_not_supported when customer is asked for TOTP', async () => {
      // Customers do not have TOTP — the caller should never request
      // it, but if they do we must refuse rather than silently pass.
      mock.queueSelect([customerRow()]);

      const result = await reauthGate({
        db: mock.db,
        subject: { kind: 'customer', id: SUBJECT_ID },
        password: 'right',
        factor: { type: 'totp', code: '123456' },
        now: NOW,
        authConfig: AUTH_CONFIG,
      });

      expect(result).toEqual({ status: 'failed', reason: 'factor_not_supported' });
      expect(decryptTotpSecret).not.toHaveBeenCalled();
      expect(verifyTotpCode).not.toHaveBeenCalled();
    });

    it('returns factor_not_supported when customer is asked for recovery_code', async () => {
      mock.queueSelect([customerRow()]);

      const result = await reauthGate({
        db: mock.db,
        subject: { kind: 'customer', id: SUBJECT_ID },
        password: 'right',
        factor: { type: 'recovery_code', code: 'XXXXX-XXXXX' },
        now: NOW,
        authConfig: AUTH_CONFIG,
      });

      expect(result).toEqual({ status: 'failed', reason: 'factor_not_supported' });
    });

    describe('wallet factor', () => {
      it('returns ok when challenge verifies, signature verifies, nonce fresh, wallet linked', async () => {
        mock.queueSelect([customerRow()]);
        vi.mocked(verifyWalletChallenge).mockResolvedValue(NONCE);
        vi.mocked(verifyEvmWalletSignature).mockResolvedValue(WALLET_ADDRESS);
        vi.mocked(claimWalletNonce).mockResolvedValue(true);
        vi.mocked(findLinkedAccount).mockResolvedValue({
          customerId: SUBJECT_ID,
          provider: 'evm_wallet',
          providerAccountId: WALLET_ADDRESS,
        } as Awaited<ReturnType<typeof findLinkedAccount>>);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'customer', id: SUBJECT_ID },
          password: 'right',
          factor: WALLET_FACTOR,
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toMatchObject({ status: 'ok' });
      });

      it('returns wallet_challenge_invalid when JWT verify throws', async () => {
        mock.queueSelect([customerRow()]);
        vi.mocked(verifyWalletChallenge).mockRejectedValue(new Error('expired'));

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'customer', id: SUBJECT_ID },
          password: 'right',
          factor: WALLET_FACTOR,
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'wallet_challenge_invalid' });
        // Never reach the signature step when the challenge itself is bad.
        expect(verifyEvmWalletSignature).not.toHaveBeenCalled();
        expect(claimWalletNonce).not.toHaveBeenCalled();
      });

      it('returns wallet_signature_invalid on a bad signature', async () => {
        mock.queueSelect([customerRow()]);
        vi.mocked(verifyWalletChallenge).mockResolvedValue(NONCE);
        vi.mocked(verifyEvmWalletSignature).mockResolvedValue(null);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'customer', id: SUBJECT_ID },
          password: 'right',
          factor: WALLET_FACTOR,
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'wallet_signature_invalid' });
        // Do NOT burn the nonce or look up the link when the signature
        // was bad — a future legitimate caller with the same challenge
        // must still be able to use it.
        expect(claimWalletNonce).not.toHaveBeenCalled();
        expect(findLinkedAccount).not.toHaveBeenCalled();
      });

      it('returns wallet_challenge_invalid when nonce replay burns fail', async () => {
        mock.queueSelect([customerRow()]);
        vi.mocked(verifyWalletChallenge).mockResolvedValue(NONCE);
        vi.mocked(verifyEvmWalletSignature).mockResolvedValue(WALLET_ADDRESS);
        vi.mocked(claimWalletNonce).mockResolvedValue(false); // nonce seen before

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'customer', id: SUBJECT_ID },
          password: 'right',
          factor: WALLET_FACTOR,
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'wallet_challenge_invalid' });
        // Crucially — linked-account lookup is NOT reached, so an
        // attacker replaying a valid signature cannot probe whether
        // the wallet is still bound to this customer.
        expect(findLinkedAccount).not.toHaveBeenCalled();
      });

      it('returns wallet_signature_invalid when the signing wallet is linked to a DIFFERENT customer', async () => {
        // This is the "I signed with my wallet but submitted your
        // customer id" attack. Conflate with signature-invalid so
        // there is no timing signal distinguishing the two cases.
        mock.queueSelect([customerRow()]);
        vi.mocked(verifyWalletChallenge).mockResolvedValue(NONCE);
        vi.mocked(verifyEvmWalletSignature).mockResolvedValue(WALLET_ADDRESS);
        vi.mocked(claimWalletNonce).mockResolvedValue(true);
        vi.mocked(findLinkedAccount).mockResolvedValue({
          customerId: '99999999-9999-4999-8999-999999999999',
          provider: 'evm_wallet',
          providerAccountId: WALLET_ADDRESS,
        } as Awaited<ReturnType<typeof findLinkedAccount>>);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'customer', id: SUBJECT_ID },
          password: 'right',
          factor: WALLET_FACTOR,
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'wallet_signature_invalid' });
      });

      it('returns wallet_signature_invalid when the wallet is not linked at all', async () => {
        mock.queueSelect([customerRow()]);
        vi.mocked(verifyWalletChallenge).mockResolvedValue(NONCE);
        vi.mocked(verifyEvmWalletSignature).mockResolvedValue(WALLET_ADDRESS);
        vi.mocked(claimWalletNonce).mockResolvedValue(true);
        vi.mocked(findLinkedAccount).mockResolvedValue(null);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'customer', id: SUBJECT_ID },
          password: 'right',
          factor: WALLET_FACTOR,
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'wallet_signature_invalid' });
      });
    });
  });

  /* ======================================================================== */
  /*  Firm branch                                                              */
  /* ======================================================================== */

  describe('firm branch', () => {
    beforeEach(() => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
    });

    it('returns ok with factor=none when password matches', async () => {
      mock.queueSelect([firmRow()]);

      const result = await reauthGate({
        db: mock.db,
        subject: { kind: 'firm', id: SUBJECT_ID },
        password: 'right',
        factor: { type: 'none' },
        now: NOW,
        authConfig: AUTH_CONFIG,
      });

      expect(result).toMatchObject({ status: 'ok' });
    });

    describe('totp factor', () => {
      it('returns ok when TOTP enrolled + code verifies', async () => {
        mock.queueSelect([firmRow({ totpEnrolled: true })]);
        vi.mocked(decryptTotpSecret).mockReturnValue('BASE32SECRET');
        vi.mocked(verifyAndConsumeTotpCode).mockResolvedValue(true);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'firm', id: SUBJECT_ID },
          password: 'right',
          factor: { type: 'totp', code: '123456' },
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toMatchObject({ status: 'ok' });
        expect(decryptTotpSecret).toHaveBeenCalledWith(
          'ct-xxx',
          'nonce-xxx',
          1,
          AUTH_CONFIG.totpEncryptionKey,
        );
        expect(verifyAndConsumeTotpCode).toHaveBeenCalledWith(
          mock.db,
          SUBJECT_ID,
          'firm',
          'BASE32SECRET',
          '123456',
          AUTH_CONFIG,
        );
      });

      it('returns totp_not_enrolled when firm has no TOTP set up yet', async () => {
        mock.queueSelect([firmRow({ totpEnrolled: false })]);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'firm', id: SUBJECT_ID },
          password: 'right',
          factor: { type: 'totp', code: '123456' },
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'totp_not_enrolled' });
        expect(decryptTotpSecret).not.toHaveBeenCalled();
        expect(verifyAndConsumeTotpCode).not.toHaveBeenCalled();
      });

      it('returns totp_invalid when the code does not match', async () => {
        mock.queueSelect([firmRow({ totpEnrolled: true })]);
        vi.mocked(decryptTotpSecret).mockReturnValue('BASE32SECRET');
        vi.mocked(verifyAndConsumeTotpCode).mockResolvedValue(false);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'firm', id: SUBJECT_ID },
          password: 'right',
          factor: { type: 'totp', code: '000000' },
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'totp_invalid' });
      });
    });

    describe('recovery_code factor', () => {
      it('returns ok when the UPDATE burns exactly one unused row', async () => {
        mock.queueSelect([firmRow({ totpEnrolled: true })]);
        mock.queueExecute([{ id: 'rec-row-id' }]); // one row burned

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'firm', id: SUBJECT_ID },
          password: 'right',
          factor: { type: 'recovery_code', code: 'ABC123DEF4' },
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toMatchObject({ status: 'ok' });
        const execCall = mock.executeCalls()[0]?.sqlString ?? '';
        expect(execCall).toContain('UPDATE');
        expect(execCall).toContain('firm_user_recovery_codes');
        expect(execCall).toContain('SET used_at');
        // The WHERE must include `used_at IS NULL` or another valid
        // redemption can race-reuse the same code.
        expect(execCall).toContain('used_at IS NULL');
        expect(execCall).toContain('RETURNING id');
      });

      it('returns recovery_code_invalid when the UPDATE returns no rows', async () => {
        mock.queueSelect([firmRow({ totpEnrolled: true })]);
        mock.queueExecute([]); // no row matched

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'firm', id: SUBJECT_ID },
          password: 'right',
          factor: { type: 'recovery_code', code: 'badcode' },
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'recovery_code_invalid' });
      });
    });

    it('returns factor_not_supported for a firm presenting a wallet proof', async () => {
      mock.queueSelect([firmRow()]);

      const result = await reauthGate({
        db: mock.db,
        subject: { kind: 'firm', id: SUBJECT_ID },
        password: 'right',
        factor: WALLET_FACTOR,
        now: NOW,
        authConfig: AUTH_CONFIG,
      });

      expect(result).toEqual({ status: 'failed', reason: 'factor_not_supported' });
      // Zero wallet helpers invoked — the gate should refuse early.
      expect(verifyWalletChallenge).not.toHaveBeenCalled();
      expect(verifyEvmWalletSignature).not.toHaveBeenCalled();
      expect(claimWalletNonce).not.toHaveBeenCalled();
    });
  });

  /* ======================================================================== */
  /*  Admin branch                                                             */
  /* ======================================================================== */

  describe('admin branch', () => {
    beforeEach(() => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
    });

    it('returns ok with factor=none', async () => {
      mock.queueSelect([adminRow()]);

      const result = await reauthGate({
        db: mock.db,
        subject: { kind: 'admin', id: SUBJECT_ID },
        password: 'right',
        factor: { type: 'none' },
        now: NOW,
        authConfig: AUTH_CONFIG,
      });

      expect(result).toMatchObject({ status: 'ok' });
    });

    it('returns ok with matching TOTP', async () => {
      mock.queueSelect([adminRow({ totpEnrolled: true })]);
      vi.mocked(decryptTotpSecret).mockReturnValue('ADMINSECRET');
      vi.mocked(verifyAndConsumeTotpCode).mockResolvedValue(true);

      const result = await reauthGate({
        db: mock.db,
        subject: { kind: 'admin', id: SUBJECT_ID },
        password: 'right',
        factor: { type: 'totp', code: '123456' },
        now: NOW,
        authConfig: AUTH_CONFIG,
      });

      expect(result).toMatchObject({ status: 'ok' });
    });

    it('returns totp_not_enrolled when admin is pre-TOTP (seeded superadmin)', async () => {
      mock.queueSelect([adminRow({ totpEnrolled: false })]);

      const result = await reauthGate({
        db: mock.db,
        subject: { kind: 'admin', id: SUBJECT_ID },
        password: 'right',
        factor: { type: 'totp', code: '123456' },
        now: NOW,
        authConfig: AUTH_CONFIG,
      });

      expect(result).toEqual({ status: 'failed', reason: 'totp_not_enrolled' });
    });

    describe('admin recovery_code factor (Phase 4)', () => {
      it('returns ok when the UPDATE burns exactly one unused row', async () => {
        mock.queueSelect([adminRow({ totpEnrolled: true })]);
        mock.queueExecute([{ id: 'admin-rec-row-id' }]);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'admin', id: SUBJECT_ID },
          password: 'right',
          factor: { type: 'recovery_code', code: 'ABC-DEF-GHI' },
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toMatchObject({ status: 'ok' });
        const execCall = mock.executeCalls()[0]?.sqlString ?? '';
        expect(execCall).toContain('UPDATE');
        expect(execCall).toContain('admin_user_recovery_codes');
        expect(execCall).toContain('SET used_at');
        expect(execCall).toContain('used_at IS NULL');
        expect(execCall).toContain('RETURNING id');
      });

      it('returns recovery_code_invalid when the UPDATE returns no rows', async () => {
        mock.queueSelect([adminRow({ totpEnrolled: true })]);
        mock.queueExecute([]);

        const result = await reauthGate({
          db: mock.db,
          subject: { kind: 'admin', id: SUBJECT_ID },
          password: 'right',
          factor: { type: 'recovery_code', code: 'badcode' },
          now: NOW,
          authConfig: AUTH_CONFIG,
        });

        expect(result).toEqual({ status: 'failed', reason: 'recovery_code_invalid' });
      });
    });

    it('returns factor_not_supported when admin presents a wallet proof', async () => {
      mock.queueSelect([adminRow()]);

      const result = await reauthGate({
        db: mock.db,
        subject: { kind: 'admin', id: SUBJECT_ID },
        password: 'right',
        factor: WALLET_FACTOR,
        now: NOW,
        authConfig: AUTH_CONFIG,
      });

      expect(result).toEqual({ status: 'failed', reason: 'factor_not_supported' });
    });
  });
});
