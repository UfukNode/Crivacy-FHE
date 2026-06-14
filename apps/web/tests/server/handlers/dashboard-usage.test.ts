/**
 * Tests for dashboard usage chart handler.
 */

import { describe, expect, it, vi } from 'vitest';

import type { UsageChartDeps, UsageChartResult } from '@/server/handlers/dashboard-usage';
import { handleGetUsageChart } from '@/server/handlers/dashboard-usage';

import { buildDashboardCtx } from './dashboard-helpers';

function buildChartResult(overrides: Partial<UsageChartResult> = {}): UsageChartResult {
  return {
    period: '2026-04',
    totalRequests: 1234,
    quotaLimit: 100000,
    quotaRemaining: 98766,
    dailyBreakdown: [
      { date: '2026-04-01', count: 100 },
      { date: '2026-04-02', count: 200 },
    ],
    ...overrides,
  };
}

function buildDeps(overrides: Partial<UsageChartDeps> = {}): UsageChartDeps {
  return {
    getUsageChart: vi.fn().mockResolvedValue(buildChartResult()),
    ...overrides,
  };
}

describe('handleGetUsageChart', () => {
  it('returns usage chart for current period when no period specified', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handleGetUsageChart(deps, ctx);

    expect(result.totalRequests).toBe(1234);
    expect(result.dailyBreakdown).toHaveLength(2);
    expect(deps.getUsageChart).toHaveBeenCalledWith(ctx, expect.stringMatching(/^\d{4}-\d{2}$/));
  });

  it('passes explicit period when provided', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    await handleGetUsageChart(deps, ctx, '2026-03');

    expect(deps.getUsageChart).toHaveBeenCalledWith(ctx, '2026-03');
  });

  it('returns null quota for unlimited tiers', async () => {
    const deps = buildDeps({
      getUsageChart: vi
        .fn()
        .mockResolvedValue(buildChartResult({ quotaLimit: null, quotaRemaining: null })),
    });
    const ctx = buildDashboardCtx({ tier: 'enterprise' });
    const result = await handleGetUsageChart(deps, ctx);

    expect(result.quotaLimit).toBeNull();
    expect(result.quotaRemaining).toBeNull();
  });
});
