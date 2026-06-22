/**
 * Unit tests for `lib/fraud/decline-counter.ts`. Covers the pure
 * `evaluateDeclineLock` projector + the audit + UPDATE wire paths
 * for `incrementDecline` / `resetDecline` against a stub db.
 *
 * `writeAudit` is module-mocked because the real implementation
 * runs Drizzle insert + RETURNING + row hydration, which are not
 * the contract this test cares about. We assert on the call shape
 * (action + meta) of the mock and on the customers UPDATE path
 * directly.
 */

import { describe, expect, it, vi } from 'vitest';

const { writeAuditMock } = vi.hoisted(() => ({
  // Untyped rest signature so `mock.calls[i][1]` stays reachable from
  // the assertion sites — typing the mock as zero-arity collapses the
  // call tuple to `[]` and `[1]` becomes a TS index-out-of-range error.
  writeAuditMock: vi.fn(async (..._args: unknown[]) => ({ id: 1 })),
}));

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: writeAuditMock,
}));

import {
  KYC_DECLINE_DEFAULT_THRESHOLD,
  evaluateDeclineLock,
  incrementDecline,
  resetDecline,
} from '@/lib/fraud/decline-counter';

const NOW = new Date('2026-05-10T12:00:00Z');
const CUSTOMER_ID = 'a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d';

describe('evaluateDeclineLock', () => {
  it('returns unlocked when count is under threshold', () => {
    const verdict = evaluateDeclineLock(
      { consecutiveKycDeclines: 1, lastDeclineAt: NOW },
      NOW,
    );
    expect(verdict).toEqual({
      locked: false,
      count: 1,
      threshold: KYC_DECLINE_DEFAULT_THRESHOLD,
      cooldownEndsAt: null,
    });
  });

  it('returns unlocked when lastDeclineAt is null even at threshold', () => {
    // Defensive: a row that somehow has count=3 without a timestamp
    // shouldn't perma-lock the customer. The cooldown anchor is
    // load-bearing.
    const verdict = evaluateDeclineLock(
      { consecutiveKycDeclines: KYC_DECLINE_DEFAULT_THRESHOLD, lastDeclineAt: null },
      NOW,
    );
    expect(verdict.locked).toBe(false);
  });

  it('returns locked when count >= threshold AND lastDeclineAt is inside cooldown window', () => {
    const verdict = evaluateDeclineLock(
      { consecutiveKycDeclines: 3, lastDeclineAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
      NOW,
      KYC_DECLINE_DEFAULT_THRESHOLD,
      24,
    );
    expect(verdict.locked).toBe(true);
    expect(verdict.cooldownEndsAt).not.toBeNull();
    // Cooldown window = lastDeclineAt + 24h.
    const expected = new Date(NOW.getTime() - 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
    expect(verdict.cooldownEndsAt!.getTime()).toBe(expected.getTime());
  });

  it('returns unlocked when cooldown elapsed even past threshold', () => {
    const verdict = evaluateDeclineLock(
      { consecutiveKycDeclines: 5, lastDeclineAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000) },
      NOW,
      KYC_DECLINE_DEFAULT_THRESHOLD,
      24,
    );
    expect(verdict.locked).toBe(false);
    expect(verdict.cooldownEndsAt).toBeNull();
  });

  it('clamps negative count to 0', () => {
    const verdict = evaluateDeclineLock(
      { consecutiveKycDeclines: -3, lastDeclineAt: NOW },
      NOW,
    );
    expect(verdict.count).toBe(0);
    expect(verdict.locked).toBe(false);
  });
});

describe('incrementDecline', () => {
  it('updates customers row + writes fraud.kyc_decline_strike audit', async () => {
    writeAuditMock.mockClear();
    let updateSet: Record<string, unknown> | null = null;

    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updateSet = values;
          return {
            where: () => ({
              returning: async () => [{ count: 1 }],
            }),
          };
        },
      }),
    } as unknown as Parameters<typeof incrementDecline>[0];

    const result = await incrementDecline(db, {
      customerId: CUSTOMER_ID,
      surface: 'webhook',
      auditContext: { ip: null, userAgent: null, requestId: 'req-test' },
      kycSessionId: 'session-1',
      now: NOW,
    });

    expect(updateSet).not.toBeNull();
    expect(updateSet).toHaveProperty('consecutiveKycDeclines');
    expect(updateSet).toHaveProperty('lastDeclineAt', NOW);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0]![1]).toMatchObject({
      action: 'fraud.kyc_decline_strike',
      meta: {
        surface: 'webhook',
        kycSessionId: 'session-1',
        count: 1,
        thresholdCrossed: false,
      },
    });
    expect(result.count).toBe(1);
    expect(result.thresholdCrossed).toBe(false);
  });

  it('reports thresholdCrossed=true when post-increment count meets threshold', async () => {
    writeAuditMock.mockClear();
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ count: KYC_DECLINE_DEFAULT_THRESHOLD }],
          }),
        }),
      }),
    } as unknown as Parameters<typeof incrementDecline>[0];

    const result = await incrementDecline(db, {
      customerId: CUSTOMER_ID,
      surface: 'pull_fallback',
      auditContext: { ip: null, userAgent: null, requestId: 'req-test' },
      kycSessionId: 'session-1',
      now: NOW,
    });

    expect(result.count).toBe(KYC_DECLINE_DEFAULT_THRESHOLD);
    expect(result.thresholdCrossed).toBe(true);
    expect(writeAuditMock.mock.calls[0]![1]).toMatchObject({
      action: 'fraud.kyc_decline_strike',
      meta: { thresholdCrossed: true },
    });
  });
});

describe('resetDecline', () => {
  it('writes fraud.kyc_decline_reset audit ONLY when previous count > 0', async () => {
    writeAuditMock.mockClear();
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ count: 2 }],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    } as unknown as Parameters<typeof resetDecline>[0];

    const result = await resetDecline(db, {
      customerId: CUSTOMER_ID,
      auditContext: { ip: null, userAgent: null, requestId: 'req-test' },
      kycSessionId: 'session-1',
      now: NOW,
    });

    expect(result.previousCount).toBe(2);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0]![1]).toMatchObject({
      action: 'fraud.kyc_decline_reset',
      meta: { previousCount: 2 },
    });
  });

  it('skips audit when previous count was 0', async () => {
    writeAuditMock.mockClear();
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ count: 0 }],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    } as unknown as Parameters<typeof resetDecline>[0];

    await resetDecline(db, {
      customerId: CUSTOMER_ID,
      auditContext: { ip: null, userAgent: null, requestId: 'req-test' },
      kycSessionId: 'session-1',
      now: NOW,
    });

    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});
