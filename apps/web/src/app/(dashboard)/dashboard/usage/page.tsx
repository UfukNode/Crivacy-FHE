'use client';

import useSWR from 'swr';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { BarChart3 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsageChartData {
  period: string;
  totalRequests: number;
  quotaLimit: number | null;
  quotaRemaining: number | null;
  dailyBreakdown: readonly { date: string; count: number }[];
}


// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function UsageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Usage analytics page -- shows request volume and daily breakdown.
 */
export default function UsagePage() {
  // Single fetch, the charts endpoint already returns `dailyBreakdown`
  // (date + request count), which is everything the page displays.
  // A second `/usage/daily` request existed here historically but
  // pointed at an endpoint that never shipped; collapsing to the one
  // real source avoids the 404 and keeps the on-screen numbers in
  // sync (same query window, single DB round-trip).
  const {
    data: charts,
    error: chartsError,
    isLoading: chartsLoading,
  } = useSWR<UsageChartData>(
    '/api/internal/usage/charts',
    { refreshInterval: 60000 },
  );

  const isLoading = chartsLoading;
  const hasError = chartsError;
  const daily = charts?.dailyBreakdown ?? null;

  // Quota progress percentage
  const quotaPercent =
    charts?.quotaLimit !== null && charts?.quotaLimit !== undefined && charts.quotaLimit > 0
      ? Math.round(
          ((charts.quotaLimit - (charts.quotaRemaining ?? 0)) / charts.quotaLimit) * 100,
        )
      : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage & Billing"
        description="API request volume for the current billing period."
      />

      {isLoading && <UsageSkeleton />}

      {hasError && !isLoading && (
        <Card className="border-[var(--color-danger)]/30">
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--color-danger)]">
              Failed to load usage data. Please try refreshing the page.
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !hasError && charts && (
        <>
          {/* Current period stats */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-[var(--color-muted)]">
                  Total Requests
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {charts.totalRequests.toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">{charts.period}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-[var(--color-muted)]">
                  Quota Limit
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {charts.quotaLimit !== null
                    ? charts.quotaLimit.toLocaleString()
                    : 'Unlimited'}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-[var(--color-muted)]">
                  Remaining
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {charts.quotaRemaining !== null
                    ? charts.quotaRemaining.toLocaleString()
                    : 'Unlimited'}
                </p>
                {charts.quotaLimit !== null && charts.quotaLimit > 0 && (
                  <Progress value={quotaPercent} className="mt-2 h-2" />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Daily breakdown table, backed by `usage_aggregates` so
              the numbers match the rate-limit middleware's own
              counter. Sessions / credentials columns were removed
              because they have no aggregate source today; re-add
              them only once a dedicated counter exists. */}
          {daily !== null && daily.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Daily Breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
                        <th scope="col" className="pb-3 pr-4">Date</th>
                        <th scope="col" className="pb-3 text-right">Requests</th>
                      </tr>
                    </thead>
                    <tbody>
                      {daily.map((entry) => (
                        <tr
                          key={entry.date}
                          className="border-b border-[var(--color-border)]/50"
                        >
                          <td className="py-3 pr-4 font-medium">{entry.date}</td>
                          <td className="py-3 text-right tabular-nums">
                            {entry.count.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ) : (
            !chartsLoading && (
              <EmptyState
                icon={<BarChart3 className="h-6 w-6" />}
                title="No daily data yet"
                description="Usage data will appear here once API requests start coming in."
              />
            )
          )}
        </>
      )}
    </div>
  );
}
