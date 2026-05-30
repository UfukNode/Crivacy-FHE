'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
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
// Metric card
// ---------------------------------------------------------------------------

interface MetricCardProps {
  label: string;
  value: number;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

function MetricCard({ label, value, variant = 'default' }: MetricCardProps) {
  const colorMap: Record<string, string> = {
    default: 'text-[var(--color-fg)]',
    success: 'text-[var(--color-success)]',
    warning: 'text-[var(--color-warning)]',
    danger: 'text-[var(--color-danger)]',
  };

  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-[var(--color-muted)]">{label}</p>
        <p className={`mt-1 text-2xl font-bold ${colorMap[variant]}`}>
          {value.toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}

function MetricCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-2 h-8 w-14" />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section skeleton
// ---------------------------------------------------------------------------

function SectionSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-24" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCardSkeleton />
        <MetricCardSkeleton />
        <MetricCardSkeleton />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminSystemPage() {
  const { data: metrics, error, isLoading, mutate } = useSWR<Metrics>(
    '/api/internal/admin/system/metrics',
    { refreshInterval: 15_000 },
  );

  const handleRefresh = useCallback(() => {
    void mutate();
  }, [mutate]);

  const deletedFirms = metrics ? metrics.totalFirms - metrics.activeFirms : 0;
  const revokedSessions = metrics ? metrics.totalSessions - metrics.activeSessions : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="System Configuration"
        description="Real-time system metrics and status"
        actions={
          <div className="flex items-center gap-3">
            {metrics && (
              <Badge variant="outline" className="text-xs">
                Auto-refresh: 15s
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {/* Error */}
      {error && !isLoading && (
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3">
          <p className="flex-1 text-sm text-[var(--color-danger)]">
            Failed to load system metrics.
          </p>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            Retry
          </Button>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="space-y-6">
          <SectionSkeleton />
          <Separator />
          <SectionSkeleton />
          <Separator />
          <SectionSkeleton />
          <Separator />
          <SectionSkeleton />
        </div>
      )}

      {/* Content */}
      {metrics && (
        <div className="space-y-6">
          {/* Firms */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-[var(--color-muted)]">
                Firms
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <MetricCard label="Total" value={metrics.totalFirms} />
                <MetricCard label="Active" value={metrics.activeFirms} variant="success" />
                <MetricCard
                  label="Deleted"
                  value={deletedFirms}
                  variant={deletedFirms > 0 ? 'warning' : 'default'}
                />
              </div>
            </CardContent>
          </Card>

          {/* Sessions */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-[var(--color-muted)]">
                Sessions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <MetricCard label="Total" value={metrics.totalSessions} />
                <MetricCard label="Active" value={metrics.activeSessions} variant="success" />
                <MetricCard label="Revoked" value={revokedSessions} />
              </div>
            </CardContent>
          </Card>

          {/* Incidents */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-[var(--color-muted)]">
                Incidents
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <MetricCard label="Total" value={metrics.totalIncidents} />
                <MetricCard
                  label="Active"
                  value={metrics.activeIncidents}
                  variant={metrics.activeIncidents > 0 ? 'danger' : 'success'}
                />
              </div>
            </CardContent>
          </Card>

          {/* Audit */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-[var(--color-muted)]">
                Audit
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <MetricCard label="Total Entries" value={metrics.totalAuditEntries} />
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
