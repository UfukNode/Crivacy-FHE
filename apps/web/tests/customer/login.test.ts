// @vitest-environment node
/**
 * Customer login — enumeration-resistance + post-verify UX contract.
 *
 * Two invariants are pinned here:
 *
 *   1. Pre-verify branches look identical to each other from outside
 *      — unknown email, known email with wrong password, known email
 *      with no password set, and known email in a banned/locked state
 *      all surface `invalid_credentials`. Timing is equalised by
 *      running a dummy argon2id verify on every pre-verify bail-out.
 *
 *   2. Status-specific error codes (`account_banned`, `account_locked`,
 *      `email_not_verified`) fire only after the caller has proved
 *      knowledge of the password. A random-password spray cannot
 *      reach them, so it is safe for the legitimate owner to see the
 *      real reason instead of the generic credential error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';
import {
  loginCustomer,
  resetDummyPasswordHashCacheForTests,
} from '@/lib/customer/login';

vi.mock('@/lib/auth/password', () => ({
  hashPassword: vi.fn(async () => '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'),
  verifyPassword: vi.fn(async () => false),
}));

// F-XCC-AE Layer 2 (progressive delay / tarpit) holds the response for
// up to 8s on the 5th wrong-pwd attempt. The unit tests exercise that
// branch (lockout-trip + post-lockout success) but only care about the
// audit + response shape, not the wall-clock delay. Stub `sleep` to
// resolve immediately so the suite stays sub-second; the real timing
// is pinned by `apps/web/.race-test/fix-batch-pr3-lockout-mitigation.mjs`.
vi.mock('@/lib/auth/lockout', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/lockout')>(
    '@/lib/auth/lockout',
  );
  return {
    ...actual,
    sleep: vi.fn(async () => {}),
  };
});

vi.mock('@/lib/auth/jwt', () => ({
  signAccessToken: vi.fn(async () => ({
    token: 'access-token-stub',
    jti: 'jti-stub',
    expiresAt: new Date('2026-04-17T13:00:00.000Z'),
  })),
  generateRefreshToken: vi.fn(() => ({
    token: 'refresh-stub',
    tokenHash: 'refresh-hash-stub',
  })),
}));

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => ({
    id: 1,
    actorKind: 'system',
    actorId: null,
    actorLabel: 'customer-auth',
    firmId: null,
    action: 'customer.login.failed',
    targetKind: 'customer',
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
const mockHashPassword = vi.mocked(password.hashPassword);
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
} as unknown as Parameters<typeof loginCustomer>[1];

const CUSTOMER_CONFIG = {
  maxFailedAttempts: 5,
  lockDurationMinutes: 30,
  customerRefreshTtlSeconds: 86400,
  customerRememberMeTtlDays: 30,
  turnstileSecretKey: 'dummy',
} as unknown as Parameters<typeof loginCustomer>[2];

const LOGIN_PARAMS = {
  email: 'victim@example.com',
  password: 'attacker-guess-123',
  ip: '203.0.113.5',
  userAgent: 'test/1.0',
  rememberMe: false,
};

const CUSTOMER_ID = '01234567-89ab-4cde-9f01-23456789abcd';

interface DbRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string | null;
  status: string;
  failed_login_attempts: number;
  locked_at: string | null;
  email_verified_at: string | null;
  deleted_at: string | null;
}

function buildCustomerRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: CUSTOMER_ID,
    email: 'victim@example.com',
    password_hash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$cmVhbA',
    display_name: 'Victim',
    status: 'active',
    failed_login_attempts: 0,
    locked_at: null,
    email_verified_at: '2026-04-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  };
}

function buildDb(selectResult: { rows: DbRow[] }): CrivacyDatabase {
  const execute = vi.fn();
  execute.mockResolvedValueOnce(selectResult);
  // Default fallback for unrelated execute calls (counter UPDATE,
  // audit INSERT, etc.) returns an empty result set. The
  // security_events_outbox INSERT triggered on the lockout edge
  // (customer.account_locked) requires `rows[0].id` to be defined;
  // use a default-mock implementation that pattern-matches on the
  // raw SQL text and returns a fake event id only for that call.
  execute.mockImplementation(async (arg: unknown) => {
    // Drizzle `sql\`\`` produces an object with a `queryChunks` array;
    // its serialized text contains the table identifier when
    // present. Falling back to JSON.stringify keeps the matcher
    // robust across drizzle minor versions.
    const text = (() => {
      try {
        return JSON.stringify(arg);
      } catch {
        return '';
      }
    })();
    if (text.includes('security_events_outbox')) {
      return { rows: [{ id: 'evt-fake-id' }] };
    }
    return { rows: [] };
  });
  // F-A1-AUDIT-ATOMIC-001: `loginCustomer` wraps the failed-login
  // counter UPDATE + audit emit in `db.transaction(...)`. The
  // unit-test fake exposes a tx that proxies straight to the same
  // execute mock — this is not a real ACID rollback (impossible in
  // a vitest fake), but it lets the call site exercise the wrap
  // shape and verify the audit emit fires once. Real-Postgres
  // atomicity is asserted by the RLS integration suite.
  const db: { execute: typeof execute; transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> } = {
    execute,
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      return cb({ execute, insert: () => ({ values: () => ({ returning: vi.fn(async () => []) }) }) });
    }),
  };
  return db as unknown as CrivacyDatabase;
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resetDummyPasswordHashCacheForTests();
  mockVerifyPassword.mockResolvedValue(false);
  mockHashPassword.mockResolvedValue(
    '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loginCustomer — timing uniformity', () => {
  it('runs verifyPassword when the email is unknown', async () => {
    const db = buildDb({ rows: [] });

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(mockHashPassword).toHaveBeenCalledTimes(1);
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });

  it('runs verifyPassword when the customer row is soft-deleted', async () => {
    const db = buildDb({
      rows: [buildCustomerRow({ deleted_at: '2026-03-01T00:00:00.000Z' })],
    });

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });

  it('runs verifyPassword when the account has no password_hash (wallet-only)', async () => {
    const db = buildDb({
      rows: [buildCustomerRow({ password_hash: null })],
    });

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });

  it('runs verifyPassword on the normal wrong-password path', async () => {
    const db = buildDb({ rows: [buildCustomerRow()] });
    mockVerifyPassword.mockResolvedValue(false);

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });

  it('reuses the cached dummy hash across consecutive unknown-email logins', async () => {
    const db1 = buildDb({ rows: [] });
    const db2 = buildDb({ rows: [] });

    await expect(
      loginCustomer(db1, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(
      loginCustomer(db2, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });

    expect(mockHashPassword).toHaveBeenCalledTimes(1);
    expect(mockVerifyPassword).toHaveBeenCalledTimes(2);
  });
});

describe('loginCustomer — pre-verify enumeration resistance', () => {
  it('returns invalid_credentials for a banned account on wrong password (no leak)', async () => {
    const db = buildDb({ rows: [buildCustomerRow({ status: 'banned' })] });
    mockVerifyPassword.mockResolvedValue(false);

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    // The banned status stays hidden: audit records the wrong-password
    // branch, not the ban — an attacker spraying passwords sees the
    // same response as on an active account.
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      action: 'customer.login.failed',
      meta: { reason: 'invalid_password' },
    });
  });

  it('returns invalid_credentials for a locked account on wrong password (no leak)', async () => {
    const lockedAt = new Date('2026-04-17T12:00:00.000Z');
    const inWindow = new Date('2026-04-17T12:05:00.000Z');
    const db = buildDb({
      rows: [
        buildCustomerRow({
          status: 'locked',
          locked_at: lockedAt.toISOString(),
        }),
      ],
    });
    mockVerifyPassword.mockResolvedValue(false);

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS, () => inWindow),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'invalid_password' },
    });
  });

  it('collapses the lockout-triggering attempt to invalid_credentials', async () => {
    const db = buildDb({
      rows: [buildCustomerRow({ failed_login_attempts: 4 })],
    });
    mockVerifyPassword.mockResolvedValue(false);

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'account_locked_now', failedAttempts: 5 },
    });
  });

  it('audits wallet-only account probes under reason=no_password_set but returns invalid_credentials', async () => {
    const db = buildDb({
      rows: [buildCustomerRow({ password_hash: null })],
    });

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'no_password_set' },
    });
  });

  it('does not audit on the unknown-email branch (no customer id)', async () => {
    const db = buildDb({ rows: [] });

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });
});

describe('loginCustomer — post-verify status surfacing', () => {
  it('returns account_banned when the owner enters the correct password on a banned account', async () => {
    const db = buildDb({ rows: [buildCustomerRow({ status: 'banned' })] });
    // Owner knows their own password — verify passes, then the ban
    // check fires. Surfacing the real reason here is safe because an
    // attacker spraying random passwords cannot reach this line.
    mockVerifyPassword.mockResolvedValue(true);

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'account_banned' });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'account_banned', status: 'banned' },
    });
  });

  it('returns account_suspended with dedicated code (reversible, distinct from banned)', async () => {
    const db = buildDb({ rows: [buildCustomerRow({ status: 'suspended' })] });
    mockVerifyPassword.mockResolvedValue(true);

    // AUD-X-ERROR-001 fix — suspended users get `account_suspended`
    // so the UI can show an appeal path instead of treating them as
    // terminally banned.
    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'account_suspended' });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'account_suspended', status: 'suspended' },
    });
  });

  it('returns account_locked when the owner enters the correct password on a locked-and-still-within-window account', async () => {
    const lockedAt = new Date('2026-04-17T12:00:00.000Z');
    const inWindow = new Date('2026-04-17T12:05:00.000Z');
    const db = buildDb({
      rows: [
        buildCustomerRow({
          status: 'locked',
          locked_at: lockedAt.toISOString(),
        }),
      ],
    });
    mockVerifyPassword.mockResolvedValue(true);

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS, () => inWindow),
    ).rejects.toMatchObject({ code: 'account_locked' });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'account_locked' },
    });
  });

  it('returns email_not_verified when the owner enters the correct password but never verified', async () => {
    const db = buildDb({
      rows: [buildCustomerRow({ email_verified_at: null })],
    });
    mockVerifyPassword.mockResolvedValue(true);

    await expect(
      loginCustomer(db, AUTH_CONFIG, CUSTOMER_CONFIG, LOGIN_PARAMS),
    ).rejects.toMatchObject({ code: 'email_not_verified' });
  });
});
