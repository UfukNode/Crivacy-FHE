'use client';

import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { SearchInput } from '@/components/shared/search-input';
import { EmptyState } from '@/components/shared/empty-state';
import { Pagination } from '@/components/shared/pagination';
import { RelativeTime } from '@/components/shared/relative-time';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditEntry {
  id: number;
  action: string;
  actorKind: string;
  actorId: string | null;
  actorLabel: string | null;
  firmId: string | null;
  targetKind: string | null;
  targetId: string | null;
  targetRef: string | null;
  meta: unknown;
  ts: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  total: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminAuditPage() {
  const [search, setSearch] = useState('');
  const [filterFirmId, setFilterFirmId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);

  // Build query string for SWR
  const buildUrl = useCallback(() => {
    const qs = new URLSearchParams();
    qs.set('limit', String(PAGE_SIZE));
    qs.set('offset', String((page - 1) * PAGE_SIZE));
    if (search.length > 0) qs.set('action', search);
    if (filterFirmId.length > 0) qs.set('firmId', filterFirmId);
    if (dateFrom.length > 0) qs.set('from', dateFrom);
    if (dateTo.length > 0) qs.set('to', dateTo);
    return `/api/internal/admin/audit?${qs.toString()}`;
  }, [page, search, filterFirmId, dateFrom, dateTo]);

  const { data, error, isLoading, mutate } = useSWR<AuditResponse>(buildUrl());

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Log"
        description={`${total.toLocaleString()} entries`}
        actions={
          <Button variant="outline" size="sm" onClick={() => void mutate()}>
            Refresh
          </Button>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <SearchInput
          value={search}
          onChange={handleSearchChange}
          placeholder="Filter by action..."
          className="w-56"
        />
        <div className="grid gap-1.5">
          <Label className="text-xs text-[var(--color-muted)]">Firm ID</Label>
          <Input
            value={filterFirmId}
            onChange={(e) => { setFilterFirmId(e.target.value); setPage(1); }}
            placeholder="Filter by firm ID..."
            className="h-10 w-48"
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs text-[var(--color-muted)]">From</Label>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="h-10 w-40"
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs text-[var(--color-muted)]">To</Label>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="h-10 w-40"
          />
        </div>
      </div>

      {/* Error */}
      {error && !isLoading && (
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3">
          <p className="flex-1 text-sm text-[var(--color-danger)]">
            Failed to load audit log.
          </p>
          <Button variant="outline" size="sm" onClick={() => void mutate()}>
            Retry
          </Button>
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[var(--color-border)]">
                  <tr>
                    {['Time', 'Action', 'Actor', 'Firm', 'Target'].map((h) => (
                      <th key={h} scope="col" className="px-3 py-3 font-medium text-[var(--color-muted)]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i}>
                      <td className="px-3 py-3"><Skeleton className="h-4 w-16" /></td>
                      <td className="px-3 py-3"><Skeleton className="h-4 w-32" /></td>
                      <td className="px-3 py-3"><Skeleton className="h-4 w-24" /></td>
                      <td className="px-3 py-3"><Skeleton className="h-4 w-16" /></td>
                      <td className="px-3 py-3"><Skeleton className="h-4 w-28" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Table */}
      {!isLoading && entries.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[var(--color-border)]">
                  <tr>
                    <th scope="col" className="px-3 py-3 font-medium text-[var(--color-muted)]">Time</th>
                    <th scope="col" className="px-3 py-3 font-medium text-[var(--color-muted)]">Action</th>
                    <th scope="col" className="px-3 py-3 font-medium text-[var(--color-muted)]">Actor</th>
                    <th scope="col" className="px-3 py-3 font-medium text-[var(--color-muted)]">Firm</th>
                    <th scope="col" className="px-3 py-3 font-medium text-[var(--color-muted)]">Target</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-[var(--color-muted)]">
                        <RelativeTime date={entry.ts} />
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="font-mono text-xs">
                          {entry.action}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-[var(--color-fg)]">
                        <span className="text-[var(--color-muted)]">{entry.actorKind}</span>
                        {entry.actorLabel !== null && `: ${entry.actorLabel}`}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">
                        {entry.firmId !== null ? entry.firmId.slice(0, 8) : '-'}
                      </td>
                      <td className="px-3 py-2 text-xs text-[var(--color-fg)]">
                        {entry.targetKind !== null ? (
                          <span>
                            <span className="text-[var(--color-muted)]">{entry.targetKind}</span>
                            {entry.targetRef !== null ? `: ${entry.targetRef}` : ''}
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!isLoading && !error && entries.length === 0 && (
        <EmptyState
          title="No audit entries found"
          description="Try adjusting your filters or check back later."
        />
      )}

      {/* Pagination */}
      {!isLoading && total > PAGE_SIZE && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          totalItems={total}
          pageSize={PAGE_SIZE}
        />
      )}
    </div>
  );
}
