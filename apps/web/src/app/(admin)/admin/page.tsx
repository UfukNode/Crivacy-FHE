'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Metrics {
  totalFirms: number;
  activeFirms: number;
  totalSessions: number;
  activeSessions: number;
  totalAuditEntries: number;
  totalIncidents: number;
  activeIncidents: number;
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: number;
  accent?: boolean;
}

function StatCard({ label, value, accent }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-[var(--color-muted)]">{label}</p>
        <p
          className={`mt-1 text-2xl font-bold ${accent ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg)]'}`}
        >
          {value.toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}

function StatCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-8 w-16" />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminOverviewPage() {
  const { data: metrics, error, isLoading, mutate } = useSWR<Metrics>(
    '/api/internal/admin/system/metrics',
    { refreshInterval: 30_000 },
  );

  const handleRetry = useCallback(() => {
    void mutate();
  }, [mutate]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin Overview"
        description="System-wide metrics at a glance"
        actions={
          <Button variant="outline" size="sm" onClick={handleRetry}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {error && !isLoading && (
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3">
          <p className="flex-1 text-sm text-[var(--color-danger)]">
            Failed to load metrics. Please try again.
          </p>
          <Button variant="outline" size="sm" onClick={handleRetry}>
            Retry
          </Button>
        </div>
      )}

      {isLoading && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      )}

      {metrics && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Total Firms" value={metrics.totalFirms} />
          <StatCard label="Active Firms" value={metrics.activeFirms} />
          <StatCard label="Active Sessions" value={metrics.activeSessions} />
          <StatCard label="Total Audit Entries" value={metrics.totalAuditEntries} />
          <StatCard label="Total Incidents" value={metrics.totalIncidents} />
          <StatCard
            label="Active Incidents"
            value={metrics.activeIncidents}
            accent={metrics.activeIncidents > 0}
          />
          <StatCard label="Total Sessions" value={metrics.totalSessions} />
        </div>
      )}
    </div>
  );
}
