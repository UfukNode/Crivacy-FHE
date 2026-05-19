/**
 * Dashboard usage + charts handlers.
 *
 * @module
 */

import type { DashboardContext } from '../context';

/* ---------- Types ---------- */

export interface UsageChartPoint {
  readonly date: string; // ISO date "YYYY-MM-DD"
  readonly count: number;
}

export interface UsageChartResult {
  readonly period: string; // "YYYY-MM"
  readonly totalRequests: number;
  readonly quotaLimit: number | null;
  readonly quotaRemaining: number | null;
  readonly dailyBreakdown: readonly UsageChartPoint[];
}

/* ---------- DI ---------- */

export interface UsageChartDeps {
  readonly getUsageChart: (ctx: DashboardContext, period: string) => Promise<UsageChartResult>;
}

/* ---------- Handlers ---------- */

/**
 * Get usage chart data for the firm's current billing period.
 */
export async function handleGetUsageChart(
  deps: UsageChartDeps,
  ctx: DashboardContext,
  period?: string,
): Promise<UsageChartResult> {
  const now = new Date();
  const currentPeriod =
    period ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return deps.getUsageChart(ctx, currentPeriod);
}
