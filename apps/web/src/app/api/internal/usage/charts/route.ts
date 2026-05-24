/**
 * GET /api/internal/usage/charts, usage chart data for the dashboard
 *
 * Query params:
 *   - period: optional "YYYY-MM" (defaults to current month)
 */

import { getAuthConfig } from '@/lib/auth/config';
import { resolveTierLimits } from '@/lib/ratelimit/tiers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
  getUsageForPeriod,
  getUsageTotals,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parsePeriod(raw: string | null, now: Date): { start: Date; end: Date; period: string } {
  const year = raw !== null ? Number(raw.slice(0, 4)) : now.getUTCFullYear();
  const month = raw !== null ? Number(raw.slice(5, 7)) - 1 : now.getUTCMonth();

  if (Number.isNaN(year) || Number.isNaN(month) || month < 0 || month > 11) {
    // Fallback to current month on invalid input
    return parsePeriod(null, now);
  }

  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const periodStr = `${year}-${String(month + 1).padStart(2, '0')}`;
  return { start, end, period: periodStr };
}

export const GET = dashboardRoute({
  permission: 'usage.read',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const rawPeriod = url.searchParams.get('period');
    const { start, end, period } = parsePeriod(rawPeriod, ctx.now);

    const [aggregates, totals] = await Promise.all([
      getUsageForPeriod(ctx.db, ctx.firm.id, start, end),
      getUsageTotals(ctx.db, ctx.firm.id, start, end),
    ]);

    // Group aggregates by date for daily breakdown
    const dailyMap = new Map<string, number>();
    for (const row of aggregates) {
      const dateKey =
        row.hour instanceof Date
          ? row.hour.toISOString().slice(0, 10)
          : String(row.hour).slice(0, 10);
      const existing = dailyMap.get(dateKey) ?? 0;
      dailyMap.set(dateKey, existing + (row.count ?? 0));
    }

    const dailyBreakdown = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    // Resolve the firm's contractual monthly request quota from the
    // tier table, the same source the rate-limit middleware consults,
    // so the dashboard displays the same number the API is actually
    // enforcing. `monthlyQuota === null` is the canonical "unlimited"
    // signal (enterprise tier); it must be preserved through to the
    // UI so the card can render "Unlimited" instead of a bogus
    // number.
    const tierLimits = resolveTierLimits(ctx.firm.tier);
    const quotaLimit = tierLimits.monthlyQuota;
    const quotaRemaining =
      quotaLimit === null ? null : Math.max(0, quotaLimit - totals.totalRequests);

    return ctx.json({
      period,
      totalRequests: totals.totalRequests,
      quotaLimit,
      quotaRemaining,
      dailyBreakdown,
    });
  },
});
