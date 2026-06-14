// @vitest-environment node
/**
 * Admin login step-1 — enumeration-resistance + post-verify UX.
 *
 * Same contract as the firm handler: pre-verify surfaces collapse
 * to `invalid_password` and the lock check runs only after the
 * caller has proved the password, so a legitimate admin sees the
 * real `account_locked` message without handing an attacker a
 * one-request enumeration oracle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';
import { resetDummyPasswordHashCacheForTests } from '@/lib/auth/dummy-hash';
import {
  handleAdminLogin,
  type AdminAuthHandlerDeps,
} from '@/server/handlers/admin-auth';
import type { AdminLoginUserRow } from '@/server/repositories/admin';

vi.mock('@/lib/auth/password', () => ({
  hashPassword: vi.fn(async () => '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'),
  verifyPassword: vi.fn(async () => false),
}));

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => ({
    id: 1,
    actorKind: 'system',
    actorId: null,
    actorLabel: 'admin-auth',
    firmId: null,
    action: 'admin_user.login.failed',
    targetKind: 'admin_user',
    targetId: null,
    targetRef: null,
    ip: null,
    userAgent: null,
    requestId: null,
    meta: {},
    ts: new Date(),
  })),
}));

// emitSecurityEvent inserts into `security_events_outbox` via db.execute;
// the lockout-trip path on both wrong-password and wrong-TOTP fires it,
// so the unit-test stub mocks it to a no-op rather than wiring a fake
// rows-returning execute (the integration test in `tests/integration/`
// covers the real outbox row insert + dispatcher pickup).
vi.mock('@/lib/security-events', () => ({
  emitSecurityEvent: vi.fn(async () => {}),
}));

import * as password from '@/lib/auth/password';
import * as auditWriter from '@/lib/audit/writer';

const mockVerifyPassword = vi.mocked(password.verifyPassword);
const mockWriteAudit = vi.mocked(auditWriter.writeAudit);

// --- Fixtures ---------------------------------------------------------------

const AUTH_CONFIG = {
  jwtSecret: 'test-secret',
  jwtIssuer: 'https://app.crivacy.test',
  jwtAdminAudience: 'admin',
  jwtAccessTtlSeconds: 3600,
  passwordArgon2MemoryKib: 65536,
  passwordArgon2Iterations: 3,
  passwordArgon2Parallelism: 4,
  passwordMinLength: 12,
} as unknown as AdminAuthHandlerDeps['authConfig'];

const ADMIN_USER_ID = '01234567-89ab-4cde-9f01-23456789abcd';

function adminRow(overrides: Partial<AdminLoginUserRow> = {}): AdminLoginUserRow {
  return {
    id: ADMIN_USER_ID,
    email: 'ops@crivacy.test',
    displayName: 'Ops',
    role: 'admin',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$cmVhbA',
    totpSecretCiphertext: null,
    totpSecretNonce: null,
    totpKeyVersion: null,
    totpEnrolledAt: null,
    ipAllowlist: [],
    lockedAt: null,
    lockedUntil: null,
    failedLoginCount: 0,
    ...overrides,
  };
}

function buildDeps(user: AdminLoginUserRow | null): AdminAuthHandlerDeps {
  const noopAsync = vi.fn(async () => {});
  // F-A1-AUDIT-ATOMIC-001: failed-login counter UPDATE + audit emit
  // run inside `db.transaction(async (tx) => ...)` (Pattern A-in-tx).
  // Single-session enforcement (BUG #50) also wraps in a tx. The
  // fake transaction proxies to the same execute/insert mocks so
  // tests can keep counting calls without a real ACID rollback.
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
    clientIp: '203.0.113.5',
    findAdminUserByEmail: vi.fn(async () => user),
    findAdminUserById: vi.fn(async () =>
      user !== null ? { role: user.role } : null,
    ),
    findSessionByJti: vi.fn(async () => null),
    insertSession: vi.fn(async () => ({ id: 'session-id' })),
    revokeSession: noopAsync,
    revokeAllUserSessions: noopAsync,
    updateSessionAfterRotate: noopAsync,
    // BUG #59 fix: mirror the atomic counter+lock production
    // semantics by computing the post-update count from the user's
    // prior `failedLoginCount`. Tests exercising the lockout-trip
    // branch override with `mockResolvedValueOnce({..., justLocked: true})`.
    incrementFailedLoginOrLock: vi.fn(async () => {
      const prior = user?.failedLoginCount ?? 0;
      return { failedLoginCount: prior + 1, justLocked: false };
    }),
    resetFailedLogin: noopAsync,
  };
}

const INPUT = {
  email: 'ops@crivacy.test',
  password: 'attacker-guess-123',
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

describe('handleAdminLogin — timing uniformity', () => {
  it('runs verifyPassword on the unknown-email branch', async () => {
    const deps = buildDeps(null);

    await expect(handleAdminLogin(deps, INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });

  it('runs verifyPassword on a plain wrong-password miss', async () => {
    const deps = buildDeps(adminRow());
    mockVerifyPassword.mockResolvedValue(false);

    await expect(handleAdminLogin(deps, INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });
});

describe('handleAdminLogin — pre-verify enumeration resistance', () => {
  it('returns invalid_password for a locked account on wrong password (no leak)', async () => {
    const lockedAt = new Date('2026-04-17T12:00:00.000Z');
    const lockedUntil = new Date('2026-04-17T12:30:00.000Z');
    const inWindow = new Date('2026-04-17T12:10:00.000Z');
    const deps = {
      ...buildDeps(adminRow({ lockedAt, lockedUntil })),
      clock: () => inWindow,
    };
    mockVerifyPassword.mockResolvedValue(false);

    await expect(handleAdminLogin(deps, INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    // Wrong password audit fires first; lock status stays off-response.
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'invalid_password' },
    });
  });

  it('audits the lockout-triggering attempt with reason=account_locked_now', async () => {
    const deps = buildDeps(adminRow({ failedLoginCount: 4 }));
    // The atomic UPDATE in production reports `justLocked: true`
    // on the threshold-crossing commit (BUG #59 fix).
    (deps.incrementFailedLoginOrLock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      failedLoginCount: 0,
      justLocked: true,
    });
    mockVerifyPassword.mockResolvedValue(false);

    // The lockout-trip path runs the progressive-delay tarpit at
    // `MAX_FAILED_ATTEMPTS=5` → 8s real sleep (`PROGRESSIVE_DELAY_MAX_SECONDS`).
    // Default vitest timeout is 5s; bumped here so the audit row
    // assertion runs after the sleep resolves rather than timing out.
    await expect(handleAdminLogin(deps, INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'account_locked_now', failedAttempts: 5 },
    });
  }, 12_000);

  it('does not audit on the unknown-email branch', async () => {
    const deps = buildDeps(null);

    await expect(handleAdminLogin(deps, INPUT)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });
});

describe('handleAdminLogin — post-verify status surfacing', () => {
  it('returns account_locked when the owner enters the correct password on a locked account', async () => {
    const lockedAt = new Date('2026-04-17T12:00:00.000Z');
    const lockedUntil = new Date('2026-04-17T12:30:00.000Z');
    const inWindow = new Date('2026-04-17T12:10:00.000Z');
    const deps = {
      ...buildDeps(adminRow({ lockedAt, lockedUntil })),
      clock: () => inWindow,
    };
    mockVerifyPassword.mockResolvedValue(true);

    await expect(handleAdminLogin(deps, INPUT)).rejects.toMatchObject({
      code: 'account_locked',
    });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'account_locked' },
    });
  });
});
