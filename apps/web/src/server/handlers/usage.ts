/**
 * Usage + limits handlers — business logic for `/api/v1/usage` and
 * `/api/v1/limits`.
 *
 * @module
 */

import type { NextResponse } from 'next/server';

import { getMonthlyPeriod } from '@/lib/ratelimit/periods';
import { DEFAULT_TIER_LIMITS } from '@/lib/ratelimit/tiers';
import type { AuthenticatedContext } from '../context';
import { getMonthlyUsageHistory, getUsageByEndpoint, getUsageTotals } from '../repositories';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMonthBoundaries(now: Date): { start: Date; end: Date } {
  const period = getMonthlyPeriod(now);
  return { start: period.startAt, end: period.endAt };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/usage — current period usage.
 */
export async function handleGetUsage(ctx: AuthenticatedContext): Promise<NextResponse> {
  const { start, end } = getMonthBoundaries(ctx.now);

  const [totals, byEndpoint] = await Promise.all([
    getUsageTotals(ctx.db, ctx.firm.id, start, end),
    getUsageByEndpoint(ctx.db, ctx.firm.id, start, end),
  ]);

  return ctx.json({
    period: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
    totalRequests: totals.totalRequests,
    billableRequests: totals.billableRequests,
    errors4xx: totals.errors4xx,
    errors5xx: totals.errors5xx,
    byEndpoint: byEndpoint.map((ep) => ({
      endpoint: ep.endpoint,
      count: ep.count,
      billableCount: ep.billableCount,
      errors4xx: ep.errors4xx,
      errors5xx: ep.errors5xx,
      p50Ms: ep.p50Ms,
      p95Ms: ep.p95Ms,
      p99Ms: ep.p99Ms,
    })),
  });
}

/**
 * GET /api/v1/usage/history — historical monthly usage.
 */
export async function handleGetUsageHistory(ctx: AuthenticatedContext): Promise<NextResponse> {
  const history = await getMonthlyUsageHistory(ctx.db, ctx.firm.id, 24);

  return ctx.json({
    firm: {
      tier: ctx.firm.tier,
    },
    months: history.map((h) => ({
      period: {
        start: new Date(Date.UTC(h.year, h.month - 1, 1)).toISOString(),
        end: new Date(Date.UTC(h.year, h.month, 1)).toISOString(),
      },
      totalRequests: h.totalRequests,
      billableRequests: h.billableRequests,
      errors4xx: h.errors4xx,
      errors5xx: h.errors5xx,
    })),
  });
}

/**
 * GET /api/v1/limits — rate limit + quota state.
 */
export async function handleGetLimits(ctx: AuthenticatedContext): Promise<NextResponse> {
  const tier = ctx.firm.tier as keyof typeof DEFAULT_TIER_LIMITS;
  const tierLimits = DEFAULT_TIER_LIMITS[tier];

  const period = getMonthlyPeriod(ctx.now);

  // Build rate limit window from context snapshot
  const rateLimit =
    ctx.rateLimit !== null
      ? {
          limit: ctx.rateLimit.limit,
          remaining: ctx.rateLimit.remaining,
          resetAt: new Date(ctx.now.getTime() + ctx.rateLimit.resetSeconds * 1000).toISOString(),
        }
      : {
          limit: tierLimits?.refillRatePerSec ?? 0,
          remaining: tierLimits?.refillRatePerSec ?? 0,
          resetAt: new Date(ctx.now.getTime() + 1000).toISOString(),
        };

  // Quota window — in a full implementation this would read from
  // quota_counters table. For now, use tier defaults.
  const monthlyQuota = tierLimits?.monthlyQuota ?? null;
  const quota = {
    period: 'month' as const,
    limit: monthlyQuota ?? Number.MAX_SAFE_INTEGER,
    used: 0,
    remaining: monthlyQuota ?? Number.MAX_SAFE_INTEGER,
    resetAt: period.endAt.toISOString(),
  };

  return ctx.json({
    tier: ctx.firm.tier,
    rateLimit,
    quota,
  });
}
