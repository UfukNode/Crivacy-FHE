/**
 * Usage, quota and rate-limit schemas.
 */

import { DateTimeIso, SafeCount } from '../common/primitives';
import { z } from '../registry';
import { FirmTier } from './enums';

export const UsagePeriod = z
  .object({
    start: DateTimeIso,
    end: DateTimeIso,
  })
  .openapi('UsagePeriod', {
    description: 'Inclusive start / exclusive end of a usage period.',
  });
export type UsagePeriod = z.infer<typeof UsagePeriod>;

export const UsageEndpointBreakdown = z
  .object({
    endpoint: z.string().min(1).max(256).openapi({
      description: 'Canonicalized route template (e.g. `/api/v1/sessions/:id`).',
      example: '/api/v1/sessions',
    }),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
    count: SafeCount,
    billableCount: SafeCount,
    errors4xx: SafeCount,
    errors5xx: SafeCount,
    p50Ms: z.number().int().min(0),
    p95Ms: z.number().int().min(0),
    p99Ms: z.number().int().min(0),
  })
  .openapi('UsageEndpointBreakdown', {
    description: 'Per-endpoint rollup within a usage period.',
  });
export type UsageEndpointBreakdown = z.infer<typeof UsageEndpointBreakdown>;

export const UsageSummary = z
  .object({
    period: UsagePeriod,
    totalRequests: SafeCount,
    billableRequests: SafeCount,
    errors4xx: SafeCount,
    errors5xx: SafeCount,
    byEndpoint: z.array(UsageEndpointBreakdown),
  })
  .openapi('UsageSummary', {
    description: 'Aggregate usage for the current billing period.',
  });
export type UsageSummary = z.infer<typeof UsageSummary>;

export const UsageHistoryEntry = z
  .object({
    period: UsagePeriod,
    totalRequests: SafeCount,
    billableRequests: SafeCount,
    errors4xx: SafeCount,
    errors5xx: SafeCount,
  })
  .openapi('UsageHistoryEntry', {
    description: 'One month of historical usage.',
  });
export type UsageHistoryEntry = z.infer<typeof UsageHistoryEntry>;

export const UsageHistoryResponse = z
  .object({
    firm: z.object({
      tier: FirmTier,
    }),
    months: z.array(UsageHistoryEntry),
  })
  .openapi('UsageHistoryResponse', {
    description: 'Historical usage rollup, newest month first.',
  });
export type UsageHistoryResponse = z.infer<typeof UsageHistoryResponse>;

export const RateLimitWindow = z
  .object({
    limit: SafeCount,
    remaining: SafeCount,
    resetAt: DateTimeIso,
  })
  .openapi('RateLimitWindow', {
    description:
      'Current token-bucket state for the authenticating API key. `remaining` drops to zero when the bucket is exhausted.',
  });
export type RateLimitWindow = z.infer<typeof RateLimitWindow>;

export const QuotaWindow = z
  .object({
    period: z.literal('month').openapi({ description: 'Billing period granularity.' }),
    limit: SafeCount,
    used: SafeCount,
    remaining: SafeCount,
    resetAt: DateTimeIso,
  })
  .openapi('QuotaWindow', {
    description: 'Current monthly quota counters for the authenticating API key.',
  });
export type QuotaWindow = z.infer<typeof QuotaWindow>;

export const LimitsResponse = z
  .object({
    tier: FirmTier,
    rateLimit: RateLimitWindow,
    quota: QuotaWindow,
  })
  .openapi('LimitsResponse', {
    description: 'Tier + live rate limit + live quota snapshot.',
  });
export type LimitsResponse = z.infer<typeof LimitsResponse>;

/**
 * Dashboard chart payload: a series of `{hour, count, billable, errors4xx,
 * errors5xx, p95Ms}` samples. The dashboard renders them as stacked bar
 * charts; sample points are 1 hour wide.
 */
export const UsageChartPoint = z
  .object({
    hour: DateTimeIso,
    count: SafeCount,
    billable: SafeCount,
    errors4xx: SafeCount,
    errors5xx: SafeCount,
    p95Ms: z.number().int().min(0),
  })
  .openapi('UsageChartPoint', {
    description: 'One hourly sample for a usage chart.',
  });
export type UsageChartPoint = z.infer<typeof UsageChartPoint>;

export const UsageChartsResponse = z
  .object({
    windowStart: DateTimeIso,
    windowEnd: DateTimeIso,
    points: z.array(UsageChartPoint),
  })
  .openapi('UsageChartsResponse', {
    description: 'Dashboard chart payload. Returns at most 744 hourly points (31 days).',
  });
export type UsageChartsResponse = z.infer<typeof UsageChartsResponse>;
