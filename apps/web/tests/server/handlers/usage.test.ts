/**
 * Tests for usage + limits handlers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleGetLimits, handleGetUsage, handleGetUsageHistory } from '@/server/handlers';
import * as repos from '@/server/repositories';

import { buildAuthCtx } from './helpers';

vi.mock('@/server/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof repos>();
  return {
    ...actual,
    getUsageTotals: vi.fn(),
    getUsageByEndpoint: vi.fn(),
    getMonthlyUsageHistory: vi.fn(),
  };
});

const mockTotals = vi.mocked(repos.getUsageTotals);
const mockByEndpoint = vi.mocked(repos.getUsageByEndpoint);
const mockHistory = vi.mocked(repos.getMonthlyUsageHistory);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleGetUsage', () => {
  it('returns usage totals for current period', async () => {
    mockTotals.mockResolvedValue({
      totalRequests: 1234,
      billableRequests: 1000,
      errors4xx: 50,
      errors5xx: 2,
    } as never);
    mockByEndpoint.mockResolvedValue([] as never);

    const ctx = buildAuthCtx({
      url: 'https://api.crivacy.test/api/v1/usage',
    });

    const res = await handleGetUsage(ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.period).toBeDefined();
    expect(body.period.start).toBeTypeOf('string');
    expect(body.period.end).toBeTypeOf('string');
    expect(body.totalRequests).toBe(1234);
    expect(body.billableRequests).toBe(1000);
  });
});

describe('handleGetUsageHistory', () => {
  it('returns monthly history', async () => {
    mockHistory.mockResolvedValue([
      {
        year: 2026,
        month: 3,
        totalRequests: 500,
        billableRequests: 400,
        errors4xx: 10,
        errors5xx: 0,
      },
      {
        year: 2026,
        month: 4,
        totalRequests: 1200,
        billableRequests: 1000,
        errors4xx: 50,
        errors5xx: 2,
      },
    ] as never);

    const ctx = buildAuthCtx({
      url: 'https://api.crivacy.test/api/v1/usage/history',
    });

    const res = await handleGetUsageHistory(ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.firm.tier).toBe('starter');
    expect(body.months).toBeInstanceOf(Array);
    expect(body.months.length).toBe(2);
    expect(body.months[0].totalRequests).toBe(500);
  });
});

describe('handleGetLimits', () => {
  it('returns tier limits for starter tier', async () => {
    const ctx = buildAuthCtx({ tier: 'starter' });

    const res = await handleGetLimits(ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tier).toBe('starter');
    expect(body.rateLimit).toBeDefined();
    expect(body.rateLimit.limit).toBeTypeOf('number');
    expect(body.rateLimit.remaining).toBeTypeOf('number');
    expect(body.quota).toBeDefined();
    expect(body.quota.period).toBe('month');
    expect(body.quota.limit).toBeTypeOf('number');
  });

  it('returns different limits for enterprise tier', async () => {
    const ctx = buildAuthCtx({ tier: 'enterprise' });

    const res = await handleGetLimits(ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tier).toBe('enterprise');
    // Enterprise has unlimited quota
    expect(body.quota.limit).toBe(Number.MAX_SAFE_INTEGER);
  });
});
