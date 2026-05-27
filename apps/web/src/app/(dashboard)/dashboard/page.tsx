'use client';

import useSWR from 'swr';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { BarChart3 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsageData {
  period: string;
  totalRequests: number;
  quotaLimit: number | null;
  quotaRemaining: number | null;
}


// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function OverviewSkeleton() {
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-3">
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
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Dashboard overview page -- shows firm summary and usage snapshot.
 */
export default function DashboardOverviewPage() {
  const { data: usage, error, isLoading } = useSWR<UsageData>(
    '/api/internal/usage/charts',
    { refreshInterval: 60000 },
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Your KYC integration at a glance."
      />

      {isLoading && <OverviewSkeleton />}

      {error && !isLoading && (
        <Card className="border-[var(--color-danger)]/30">
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--color-danger)]">
              Failed to load usage data. Please try refreshing the page.
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && usage && (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-[var(--color-muted)]">
                Total Requests
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{usage.totalRequests.toLocaleString()}</p>
              <p className="mt-1 text-xs text-[var(--color-muted)]">{usage.period}</p>
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
                {usage.quotaLimit !== null ? usage.quotaLimit.toLocaleString() : 'Unlimited'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-[var(--color-muted)]">
                Quota Remaining
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">
                {usage.quotaRemaining !== null
                  ? usage.quotaRemaining.toLocaleString()
                  : 'Unlimited'}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {!isLoading && !error && !usage && (
        <EmptyState
          icon={<BarChart3 className="h-6 w-6" />}
          title="Welcome to Crivacy"
          description="Start integrating KYC verification to see your usage data here."
        />
      )}
    </div>
  );
}
