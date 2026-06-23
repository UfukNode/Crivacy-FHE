// @vitest-environment node
/**
 * Customer password-reset + email-verify — enumeration-resistance
 * contract.
 *
 * These endpoints used to return a distinct `no_pending_code` status
 * when a registered email had no outstanding code, and a distinct
 * `already_verified` status when the customer had already completed
 * verification. Both were single-request enumeration oracles for a
 * remote attacker — the presence of the status disclosed that the
 * email was registered. The functions now collapse those states
 * into the generic `invalid` response so an attacker cannot tell
 * registered addresses apart from unregistered ones on a single
 * probe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';
import { verifyResetCode, resetPassword } from '@/lib/customer/reset';
import { verifyEmail } from '@/lib/customer/verify-email';

const AUTH_CONFIG = {
  passwordArgon2MemoryKib: 65536,
  passwordArgon2Iterations: 3,
  passwordArgon2Parallelism: 4,
  passwordMinLength: 12,
} as unknown as Parameters<typeof resetPassword>[1];

interface DbStubBuilder {
  readonly db: CrivacyDatabase;
  readonly execute: ReturnType<typeof vi.fn>;
}

/**
 * Build a `db` whose `execute` replays the supplied result sets in
 * order and drains everything else to `{ rows: [] }`. Each caller
 * passes the exact sequence the function under test issues.
 */
function buildDb(resultsInOrder: ReadonlyArray<{ rows: unknown[] }>): DbStubBuilder {
  const execute = vi.fn();
  for (const r of resultsInOrder) {
    execute.mockResolvedValueOnce(r);
  }
  execute.mockResolvedValue({ rows: [] });
  return { db: { execute } as unknown as CrivacyDatabase, execute };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyResetCode — enumeration resistance', () => {
  it('returns invalid when the email is unknown', async () => {
    const { db } = buildDb([{ rows: [] }]);

    const result = await verifyResetCode(db, 'unknown@target.com', '123456', 5);
    expect(result.status).toBe('invalid');
  });

  it('returns invalid when the email is known but no reset code is pending', async () => {
    // Customer found, but token query returns nothing → previously
    // leaked a distinct `no_pending_code` status. Now folded into
    // `invalid` so the response is shape-identical to the unknown-
    // email branch.
    const { db } = buildDb([
      { rows: [{ id: '01234567-89ab-4cde-9f01-23456789abcd' }] }, // customer exists
      { rows: [] }, // no token row
    ]);

    const result = await verifyResetCode(db, 'known@target.com', '123456', 5);
    expect(result.status).toBe('invalid');
  });
});

describe('resetPassword — enumeration resistance', () => {
  it('returns invalid when the email is unknown', async () => {
    const { db } = buildDb([{ rows: [] }]);

    const result = await resetPassword(
      db,
      AUTH_CONFIG,
      'unknown@target.com',
      '123456',
      'NewPasswordPass123!',
      { ip: null, userAgent: null, requestId: '11111111-1111-4111-8111-111111111111' },
      'User',
      5,
    );
    expect(result.status).toBe('invalid');
  });

  it('returns invalid when the email is known but no reset code is pending', async () => {
    const { db } = buildDb([
      {
        rows: [
          {
            id: '01234567-89ab-4cde-9f01-23456789abcd',
            status: 'active',
            email_verified_at: '2026-04-01T00:00:00.000Z',
            deleted_at: null,
          },
        ],
      },
      { rows: [] }, // no token row
    ]);

    const result = await resetPassword(
      db,
      AUTH_CONFIG,
      'known@target.com',
      '123456',
      'NewPasswordPass123!',
      { ip: null, userAgent: null, requestId: '11111111-1111-4111-8111-111111111111' },
      'User',
      5,
    );
    expect(result.status).toBe('invalid');
  });
});

describe('verifyEmail — enumeration resistance', () => {
  it('returns invalid when the email is unknown', async () => {
    const { db } = buildDb([{ rows: [] }]);

    const result = await verifyEmail(db, 'unknown@target.com', '123456', 5);
    expect(result.status).toBe('invalid');
  });

  it('returns invalid when the email is already verified', async () => {
    // Historical behaviour returned `already_verified` which — at
    // 200 OK — let a random-code probe disclose that the email was
    // registered AND verified. The status now folds into `invalid`.
    const { db } = buildDb([
      {
        rows: [
          {
            id: '01234567-89ab-4cde-9f01-23456789abcd',
            email_verified_at: '2026-04-01T00:00:00.000Z',
            status: 'active',
            deleted_at: null,
          },
        ],
      },
    ]);

    const result = await verifyEmail(db, 'known@target.com', '123456', 5);
    expect(result.status).toBe('invalid');
  });

  it('returns invalid when the email is known but no verification code is pending', async () => {
    const { db } = buildDb([
      {
        rows: [
          {
            id: '01234567-89ab-4cde-9f01-23456789abcd',
            email_verified_at: null,
            status: 'pending_verification',
            deleted_at: null,
          },
        ],
      },
      { rows: [] }, // no token row
    ]);

    const result = await verifyEmail(db, 'known@target.com', '123456', 5);
    expect(result.status).toBe('invalid');
  });
});
