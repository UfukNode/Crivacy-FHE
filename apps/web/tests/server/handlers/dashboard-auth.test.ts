// @vitest-environment node
/**
 * Firm dashboard login — enumeration-resistance + post-verify UX.
 *
 * Pre-verify bail-outs (unknown email, no password set, wrong
 * password, lock-trip) all surface `invalid_password`. The lock
 * check now runs *after* password verification, so a caller that
 * proved password knowledge sees the real `account_locked` message
 * while an attacker spraying random passwords only ever sees the
 * generic credential error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';
import { resetDummyPasswordHashCacheForTests } from '@/lib/auth/dummy-hash';
import {
  handleLogin,
  type AuthHandlerDeps,
  type LoginUserRow,
} from '@/server/handlers/dashboard-auth';

vi.mock('@/lib/auth/password', () => ({
  hashPassword: vi.fn(async () => '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'),
  verifyPassword: vi.fn(async () => false),
  // The silent-hash-rotation path in handleLogin calls `needsRehash`
  // after a successful verify. Stub it to `false` so the rotation
  // branch stays a no-op inside tests — exercising the real argon2
  // parser is unrelated to the flows this file pins.
  needsRehash: vi.fn(() => false),
}));

// Keep the TOTP primitives out of the real crypto path. The handler
// decrypts the stored TOTP secret before calling `verifyTotpCode`, so
// we stub both to return harmless values. `verifyTotpCode` defaults
// to `false` — each test flips it to `true` when exercising the
// success branch.
vi.mock('@/lib/auth/decrypt-totp', () => ({
  decryptTotpSecret: vi.fn(() => 'stub-totp-secret'),
}));

vi.mock('@/lib/auth/totp', () => ({
  verifyTotpCode: vi.fn(() => false),
  generateTotpSecret: vi.fn(() => 'stub-secret'),
  buildOtpauthUrl: vi.fn(() => 'otpauth://totp/stub'),
}));

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => ({
    id: 1,
    actorKind: 'system',
    actorId: null,
    actorLabel: 'firm-auth',
    firmId: null,
    action: 'firm_user.login.failed',
    targetKind: 'firm_user',
    targetId: null,
    targetRef: null,
    ip: null,
    userAgent: null,
    requestId: null,
    meta: {},
    ts: new Date(),
  })),
}));

import * as password from '@/lib/auth/password';
import * as auditWriter from '@/lib/audit/writer';

const mockVerifyPassword = vi.mocked(password.verifyPassword);
const mockWriteAudit = vi.mocked(auditWriter.writeAudit);

// --- Fixtures ---------------------------------------------------------------

const AUTH_CONFIG = {
  jwtSecret: 'test-secret',
  jwtIssuer: 'https://app.crivacy.test',
  jwtFirmAudience: 'firm',
  jwtAdminAudience: 'admin',
  jwtCustomerAudience: 'customer',
  jwtAccessTtlSeconds: 3600,
  passwordArgon2MemoryKib: 65536,
  passwordArgon2Iterations: 3,
  passwordArgon2Parallelism: 4,
  passwordMinLength: 12,
} as unknown as AuthHandlerDeps['authConfig'];

const FIRM_USER_ID = '01234567-89ab-4cde-9f01-23456789abcd';
const FIRM_ID = '01234567-89ab-4cde-9f01-23456789abc0';

function userRow(overrides: Partial<LoginUserRow> = {}): LoginUserRow {
  return {
    id: FIRM_USER_ID,
    firmId: FIRM_ID,
    email: 'alice@target.com',
    role: 'owner',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$cmVhbA',
    totpSecretCiphertext: null,
    totpSecretNonce: null,
    totpKeyVersion: null,
    totpEnrolledAt: null,
    lockedAt: null,
    lockedUntil: null,
    failedLoginCount: 0,
    ...overrides,
  };
}

function buildDeps(user: LoginUserRow | null): AuthHandlerDeps {
  // Each dependency gets its OWN `vi.fn()` so tests can assert on
  // call counts per method. Sharing a single `noopAsync` mock across
  // several fields (an earlier shortcut in this file) made the call
  // counter globally observable — `lockUser` firing showed up as a
  // call on every field that pointed at the same mock.
  //
  // F-A1-AUDIT-ATOMIC-001: failed-login counter UPDATE + audit emit
  // run inside `db.transaction(async (tx) => ...)` (Pattern A-in-tx).
  // The fake transaction proxies to the same execute/insert mocks so
  // tests can keep counting calls without a real ACID rollback.
  // Single-session enforcement (BUG #50) also wraps in a tx — same
  // shape covers both.
  const execute = vi.fn();
  const insert = vi.fn();
  const db = {
    execute,
    insert,
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ execute, insert })),
  };
  return {
    db: db as unknown as CrivacyDatabase,
    authConfig: AUTH_CONFIG,
    findUserByEmail: vi.fn(async () => user),
    findUserById: vi.fn(async () => user),
    findFirmById: vi.fn(async () => ({
      id: FIRM_ID,
      slug: 'acme',
      name: 'Acme',
      tier: 'standard',
      deletedAt: null,
    })),
    findSessionByJti: vi.fn(async () => null),
    insertSession: vi.fn(async () => ({ id: 'session-id' })),
    revokeSession: vi.fn(async () => {}),
    revokeAllUserSessions: vi.fn(async () => {}),
    updateSessionAfterRotate: vi.fn(async () => {}),
    // BUG #59 fix moved counter+lock into a single atomic UPDATE.
    // Mirror the production semantics in the mock by computing the
    // post-update count from the user's prior `failedLoginCount` so
    // existing test expectations (e.g. "after 1 wrong attempt the
    // audit shows failedAttempts: 2") keep firing on the right
    // numbers. Tests that exercise the lockout-trip branch override
    // this mock with `mockResolvedValueOnce({ ..., justLocked: true })`.
    incrementFailedLoginOrLock: vi.fn(async () => {
      const prior = user?.failedLoginCount ?? 0;
      return { failedLoginCount: prior + 1, justLocked: false };
    }),
    resetFailedLogin: vi.fn(async () => {}),
    saveTotpSecret: vi.fn(async () => {}),
  };
}

const LOGIN_INPUT = {
  email: 'alice@target.com',
  password: 'attacker-guess-123',
  ip: '203.0.113.5',
  userAgent: 'test/1.0',
};

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resetDummyPasswordHashCacheForTests();
  mockVerifyPassword.mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleLogin — timing uniformity', () => {
  it('runs verifyPassword when the email is unknown', async () => {
    const deps = buildDeps(null);

    await expect(handleLogin(deps, LOGIN_INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });

  it('runs verifyPassword when passwordHash is null (invite not accepted)', async () => {
    const deps = buildDeps(userRow({ passwordHash: null }));

    await expect(handleLogin(deps, LOGIN_INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });

  it('runs verifyPassword on a plain wrong-password miss', async () => {
    const deps = buildDeps(userRow());
    mockVerifyPassword.mockResolvedValue(false);

    await expect(handleLogin(deps, LOGIN_INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });
});

describe('handleLogin — pre-verify enumeration resistance', () => {
  it('returns invalid_password for a locked account on wrong password (no leak)', async () => {
    const lockedAt = new Date('2026-04-17T12:00:00.000Z');
    const lockedUntil = new Date('2026-04-17T12:15:00.000Z');
    const inWindow = new Date('2026-04-17T12:05:00.000Z');
    const deps = {
      ...buildDeps(userRow({ lockedAt, lockedUntil })),
      clock: () => inWindow,
    };
    mockVerifyPassword.mockResolvedValue(false);

    await expect(handleLogin(deps, LOGIN_INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    // Lock status does NOT appear in the audit meta for this branch —
    // the wrong-password audit fires first; the lock is only surfaced
    // when the password is right.
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'invalid_password' },
    });
  });

  it('collapses the lockout-triggering attempt to invalid_password', async () => {
    const deps = buildDeps(userRow({ failedLoginCount: 4 }));
    mockVerifyPassword.mockResolvedValue(false);

    await expect(handleLogin(deps, LOGIN_INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'account_locked_now', failedAttempts: 5 },
    });
  });

  it('audits no-password accounts under reason=no_password_set but returns invalid_password', async () => {
    const deps = buildDeps(userRow({ passwordHash: null }));

    await expect(handleLogin(deps, LOGIN_INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'no_password_set' },
    });
  });

  it('does not audit on the unknown-email branch', async () => {
    const deps = buildDeps(null);

    await expect(handleLogin(deps, LOGIN_INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });
});

describe('handleLogin — post-verify status surfacing', () => {
  it('returns account_locked when the owner enters the correct password on a locked account', async () => {
    const lockedAt = new Date('2026-04-17T12:00:00.000Z');
    const lockedUntil = new Date('2026-04-17T12:15:00.000Z');
    const inWindow = new Date('2026-04-17T12:05:00.000Z');
    const deps = {
      ...buildDeps(userRow({ lockedAt, lockedUntil })),
      clock: () => inWindow,
    };
    // Correct password → verify succeeds → post-verify lock check
    // fires → owner sees the real status instead of a confusing
    // invalid_password loop.
    mockVerifyPassword.mockResolvedValue(true);

    await expect(handleLogin(deps, LOGIN_INPUT)).rejects.toMatchObject({
      code: 'account_locked',
    });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'account_locked' },
    });
  });
});

/**
 * TOTP brute-force protection. Without the counter/lock pair below,
 * an attacker with a breach-dump password can grind the 1M-code
 * TOTP keyspace behind IP rotation in minutes — the per-IP rate
 * limit falls to rotation and the password-fail counter never
 * increments once the password is correct. These tests pin the new
 * behaviour: every wrong TOTP increments `failed_login_count` via
 * the same `incrementFailedLogin`/`lockUser` helpers the password
 * branch already uses, and the 5th miss trips the same lock.
 */
describe('handleLogin — TOTP brute-force protection', () => {
  function totpEnrolledUser(overrides: Partial<LoginUserRow> = {}): LoginUserRow {
    return userRow({
      totpSecretCiphertext: 'ciphertext-stub',
      totpSecretNonce: 'nonce-stub',
      totpKeyVersion: 1,
      totpEnrolledAt: new Date('2026-04-01T00:00:00.000Z'),
      ...overrides,
    });
  }

  it('increments the failed-login counter and throws invalid_totp_code on a non-trip TOTP miss', async () => {
    const deps = buildDeps(totpEnrolledUser({ failedLoginCount: 1 }));
    // Password right → TOTP branch fires. verifyTotpCode is stubbed
    // inside the handler via `@/lib/auth/totp` which we do not mock
    // here — so the code goes through decryptTotpSecret first.
    mockVerifyPassword.mockResolvedValue(true);

    await expect(
      handleLogin(deps, { ...LOGIN_INPUT, totpCode: '000000' }),
    ).rejects.toMatchObject({ code: 'invalid_totp_code' });

    const call = mockWriteAudit.mock.calls[0]?.[1];
    expect(call).toMatchObject({
      action: 'firm_user.login.failed',
      meta: { reason: 'invalid_totp_code', failedAttempts: 2 },
    });
    // Single atomic counter+lock UPDATE per fail (BUG #59 fix).
    expect((deps.incrementFailedLoginOrLock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it('locks the account and throws account_locked when the TOTP fail tips over MAX_FAILED_ATTEMPTS', async () => {
    // Counter at max-1 so the next wrong TOTP hits the trip branch.
    const deps = buildDeps(totpEnrolledUser({ failedLoginCount: 4 }));
    // Override the default mock to return the just-locked outcome —
    // the atomic UPDATE in production reports `justLocked: true` on
    // the threshold-crossing commit.
    (deps.incrementFailedLoginOrLock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      failedLoginCount: 0,
      justLocked: true,
    });
    mockVerifyPassword.mockResolvedValue(true);

    await expect(
      handleLogin(deps, { ...LOGIN_INPUT, totpCode: '000000' }),
    ).rejects.toMatchObject({ code: 'account_locked' });

    const call = mockWriteAudit.mock.calls[0]?.[1];
    expect(call).toMatchObject({
      action: 'firm_user.login.failed',
      meta: { reason: 'totp_locked_now', failedAttempts: 5 },
    });
    // Single atomic UPDATE handles both increment and lock now.
    expect((deps.incrementFailedLoginOrLock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });
});

/**
 * Recovery-code login path. Pins the contract for the TOTP backup:
 *   * A submitted code gets normalised + hashed + matched against
 *     the `firm_user_recovery_codes` table atomically (burn-on-use).
 *   * A miss funnels into the same per-user attempt counter the TOTP
 *     path uses, so mix-and-match attacks cannot double the
 *     effective keyspace before a lockout.
 *   * The backup path never reveals whether the user has any
 *     unused codes — a wrong submission is always
 *     `invalid_recovery_code`, a burnt code is the same.
 */
describe('handleLogin — recovery code redemption', () => {
  function totpEnrolledUser(overrides: Partial<LoginUserRow> = {}): LoginUserRow {
    return userRow({
      totpSecretCiphertext: 'ciphertext-stub',
      totpSecretNonce: 'nonce-stub',
      totpKeyVersion: 1,
      totpEnrolledAt: new Date('2026-04-01T00:00:00.000Z'),
      ...overrides,
    });
  }

  /**
   * Configure the stub DB's `execute` to return a fixed result for
   * the next query and empty rows for everything after. The handler
   * issues the atomic `UPDATE ... RETURNING` once for the recovery
   * redemption, then a handful of UPDATEs for session state — we
   * only care about the first one.
   */
  function stubRecoveryRedeem(
    deps: AuthHandlerDeps,
    result: { rows: Array<{ id: string }> },
  ): void {
    const execute = deps.db.execute as unknown as ReturnType<typeof vi.fn>;
    execute.mockResolvedValueOnce(result);
    execute.mockResolvedValue({ rows: [] });
  }

  it('accepts a valid recovery code and completes the login flow', async () => {
    const deps = buildDeps(totpEnrolledUser());
    stubRecoveryRedeem(deps, { rows: [{ id: 'rc-1' }] });
    mockVerifyPassword.mockResolvedValue(true);

    // Success path: handleLogin resolves when the recovery code
    // redemption returns a row. No failure audit write fires.
    await expect(
      handleLogin(deps, { ...LOGIN_INPUT, recoveryCode: 'ABCDE-12345' }),
    ).resolves.toMatchObject({ user: { id: FIRM_USER_ID } });

    // The audit trail for a successful login is outside the scope
    // of the recovery-code feature (handled by the session-created
    // branch). We only assert that no *failure* audit fired.
    const failureCalls = mockWriteAudit.mock.calls.filter(
      ([, input]) => (input as { action: string }).action === 'firm_user.login.failed',
    );
    expect(failureCalls.length).toBe(0);
  });

  it('rejects an unknown or already-used recovery code with invalid_recovery_code', async () => {
    const deps = buildDeps(totpEnrolledUser({ failedLoginCount: 1 }));
    // UPDATE ... RETURNING returns zero rows when the code was
    // already used or never existed — same observable shape, so
    // the handler funnels both into `invalid_recovery_code`.
    stubRecoveryRedeem(deps, { rows: [] });
    mockVerifyPassword.mockResolvedValue(true);

    await expect(
      handleLogin(deps, { ...LOGIN_INPUT, recoveryCode: 'DEAD-BEEF0' }),
    ).rejects.toMatchObject({ code: 'invalid_recovery_code' });

    const call = mockWriteAudit.mock.calls[0]?.[1];
    expect(call).toMatchObject({
      action: 'firm_user.login.failed',
      meta: { reason: 'invalid_recovery_code', failedAttempts: 2 },
    });
  });

  it('shares the lockout counter with the TOTP path — 5th bad recovery code trips account_locked', async () => {
    // Counter already at max-1 so the next miss trips. The atomic
    // UPDATE in production reports `justLocked: true` on the
    // threshold-crossing commit (BUG #59 fix).
    const deps = buildDeps(totpEnrolledUser({ failedLoginCount: 4 }));
    (deps.incrementFailedLoginOrLock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      failedLoginCount: 0,
      justLocked: true,
    });
    stubRecoveryRedeem(deps, { rows: [] });
    mockVerifyPassword.mockResolvedValue(true);

    await expect(
      handleLogin(deps, { ...LOGIN_INPUT, recoveryCode: 'DEAD-BEEF0' }),
    ).rejects.toMatchObject({ code: 'account_locked' });

    const call = mockWriteAudit.mock.calls[0]?.[1];
    expect(call).toMatchObject({
      action: 'firm_user.login.failed',
      meta: { reason: 'recovery_locked_now', failedAttempts: 5 },
    });
    expect((deps.incrementFailedLoginOrLock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it('prefers recovery code over totp when both are supplied', async () => {
    // Security property: submitting both does NOT double the
    // effective attempt count. The handler takes the recovery-code
    // branch and never falls through to TOTP, so the 5-attempt cap
    // is the same regardless of what the caller stuffs in.
    const deps = buildDeps(totpEnrolledUser());
    stubRecoveryRedeem(deps, { rows: [{ id: 'rc-1' }] });
    mockVerifyPassword.mockResolvedValue(true);

    await expect(
      handleLogin(deps, {
        ...LOGIN_INPUT,
        recoveryCode: 'ABCDE-12345',
        totpCode: '000000',
      }),
    ).resolves.toMatchObject({ user: { id: FIRM_USER_ID } });
  });
});
