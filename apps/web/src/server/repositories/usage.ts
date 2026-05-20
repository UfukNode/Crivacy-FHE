/**
 * Usage repository — data access for `usage_events`, `usage_aggregates`,
 * `rate_limit_buckets`, and `quota_counters`.
 *
 * @module
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { usageAggregates, usageEvents } from '@/lib/db/schema';
import type { NewUsageEvent, UsageAggregate } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Write — usage event recording
// ---------------------------------------------------------------------------

export async function recordUsageEvent(db: CrivacyDatabase, event: NewUsageEvent): Promise<void> {
  await db.insert(usageEvents).values(event);
}

// ---------------------------------------------------------------------------
// Read — current period usage
// ---------------------------------------------------------------------------

/**
 * Aggregate usage for a firm within a time window. Groups by endpoint.
 */
export async function getUsageForPeriod(
  db: CrivacyDatabase,
  firmId: string,
  start: Date,
  end: Date,
): Promise<readonly UsageAggregate[]> {
  return db
    .select()
    .from(usageAggregates)
    .where(
      and(
        eq(usageAggregates.firmId, firmId),
        gte(usageAggregates.hour, start),
        lte(usageAggregates.hour, end),
      ),
    )
    .orderBy(desc(usageAggregates.hour));
}

/**
 * Aggregate totals for a firm within a time window. Returns a single
 * row with summed counts.
 */
export async function getUsageTotals(
  db: CrivacyDatabase,
  firmId: string,
  start: Date,
  end: Date,
): Promise<{
  totalRequests: number;
  billableRequests: number;
  errors4xx: number;
  errors5xx: number;
}> {
  const result = await db
    .select({
      totalRequests: sql<number>`coalesce(sum(${usageAggregates.count}), 0)::int`,
      billableRequests: sql<number>`coalesce(sum(${usageAggregates.billableCount}), 0)::int`,
      errors4xx: sql<number>`coalesce(sum(${usageAggregates.errors4xx}), 0)::int`,
      errors5xx: sql<number>`coalesce(sum(${usageAggregates.errors5xx}), 0)::int`,
    })
    .from(usageAggregates)
    .where(
      and(
        eq(usageAggregates.firmId, firmId),
        gte(usageAggregates.hour, start),
        lte(usageAggregates.hour, end),
      ),
    );

  const row = result[0];
  return {
    totalRequests: row?.totalRequests ?? 0,
    billableRequests: row?.billableRequests ?? 0,
    errors4xx: row?.errors4xx ?? 0,
    errors5xx: row?.errors5xx ?? 0,
  };
}

/**
 * Per-endpoint usage breakdown for a firm within a time window.
 */
export async function getUsageByEndpoint(
  db: CrivacyDatabase,
  firmId: string,
  start: Date,
  end: Date,
): Promise<
  readonly {
    endpoint: string;
    count: number;
    billableCount: number;
    errors4xx: number;
    errors5xx: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  }[]
> {
  return db
    .select({
      endpoint: usageAggregates.endpoint,
      count: sql<number>`coalesce(sum(${usageAggregates.count}), 0)::int`,
      billableCount: sql<number>`coalesce(sum(${usageAggregates.billableCount}), 0)::int`,
      errors4xx: sql<number>`coalesce(sum(${usageAggregates.errors4xx}), 0)::int`,
      errors5xx: sql<number>`coalesce(sum(${usageAggregates.errors5xx}), 0)::int`,
      p50Ms: sql<number>`coalesce(max(${usageAggregates.p50Ms}), 0)::int`,
      p95Ms: sql<number>`coalesce(max(${usageAggregates.p95Ms}), 0)::int`,
      p99Ms: sql<number>`coalesce(max(${usageAggregates.p99Ms}), 0)::int`,
    })
    .from(usageAggregates)
    .where(
      and(
        eq(usageAggregates.firmId, firmId),
        gte(usageAggregates.hour, start),
        lte(usageAggregates.hour, end),
      ),
    )
    .groupBy(usageAggregates.endpoint)
    .orderBy(desc(sql`sum(${usageAggregates.count})`));
}

/**
 * Monthly aggregates for historical usage (up to 24 months).
 */
export async function getMonthlyUsageHistory(
  db: CrivacyDatabase,
  firmId: string,
  months = 24,
): Promise<
  readonly {
    year: number;
    month: number;
    totalRequests: number;
    billableRequests: number;
    errors4xx: number;
    errors5xx: number;
  }[]
> {
  return db
    .select({
      year: sql<number>`extract(year from ${usageAggregates.hour})::int`,
      month: sql<number>`extract(month from ${usageAggregates.hour})::int`,
      totalRequests: sql<number>`coalesce(sum(${usageAggregates.count}), 0)::int`,
      billableRequests: sql<number>`coalesce(sum(${usageAggregates.billableCount}), 0)::int`,
      errors4xx: sql<number>`coalesce(sum(${usageAggregates.errors4xx}), 0)::int`,
      errors5xx: sql<number>`coalesce(sum(${usageAggregates.errors5xx}), 0)::int`,
    })
    .from(usageAggregates)
    .where(
      and(
        eq(usageAggregates.firmId, firmId),
        gte(usageAggregates.hour, sql`now() - interval '${sql.raw(String(months))} months'`),
      ),
    )
    .groupBy(
      sql`extract(year from ${usageAggregates.hour})`,
      sql`extract(month from ${usageAggregates.hour})`,
    )
    .orderBy(
      desc(sql`extract(year from ${usageAggregates.hour})`),
      desc(sql`extract(month from ${usageAggregates.hour})`),
    );
}
