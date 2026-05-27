'use client';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { SearchInput } from '@/components/shared/search-input';
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
  targetKind: string | null;
  targetId: string | null;
  targetRef: string | null;
  ip: string | null;
  requestId: string | null;
  meta: Record<string, unknown> | null;
  ts: string;
}

interface AuditListResult {
  entries: readonly AuditEntry[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;


// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function AuditSkeleton() {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Audit log page -- view firm activity history with search and pagination.
 */
export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const offset = (page - 1) * PAGE_SIZE;
  const apiUrl = `/api/internal/audit-log?limit=${PAGE_SIZE}&offset=${offset}`;

  const { data, error, isLoading } = useSWR<AuditListResult>(apiUrl);

  // Client-side search filter on current page entries
  const filteredEntries = useMemo(() => {
    if (!data) return [];
    if (search.trim().length === 0) return data.entries;
    const q = search.toLowerCase();
    return data.entries.filter(
      (e) =>
        e.action.toLowerCase().includes(q) ||
        (e.actorLabel !== null && e.actorLabel.toLowerCase().includes(q)) ||
        (e.targetKind !== null && e.targetKind.toLowerCase().includes(q)) ||
        (e.targetRef !== null && e.targetRef.toLowerCase().includes(q)) ||
        (e.ip !== null && e.ip.includes(q)),
    );
  }, [data, search]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Log"
        description="Activity history for your firm. All actions are logged and tamper-evident."
      />

      {/* Search */}
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search actions, actors, targets..."
        className="max-w-sm"
      />

      {/* Error state */}
      {error && !isLoading && (
        <Card className="border-[var(--color-danger)]/30">
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--color-danger)]">
              Failed to load audit log. Please try refreshing the page.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {isLoading && <AuditSkeleton />}

      {/* Empty state */}
      {!isLoading && !error && data && data.entries.length === 0 && (
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title="No audit entries yet"
          description="Activity will be logged here as you and your team use the platform."
        />
      )}

      {/* Audit table */}
      {!isLoading && data && filteredEntries.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
                    <th scope="col" className="pb-3 pr-4">Time</th>
                    <th scope="col" className="pb-3 pr-4">Action</th>
                    <th scope="col" className="pb-3 pr-4">Actor</th>
                    <th scope="col" className="pb-3 pr-4">Target</th>
                    <th scope="col" className="pb-3">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-b border-[var(--color-border)]/50"
                    >
                      <td className="py-3 pr-4 text-[var(--color-muted)]">
                        <RelativeTime date={entry.ts} className="text-xs" />
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant="outline" className="font-mono text-xs">
                          {entry.action}
                        </Badge>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex max-w-[220px] flex-col">
                          <span
                            className="truncate text-sm"
                            title={entry.actorLabel ?? entry.actorKind}
                          >
                            {entry.actorLabel ?? entry.actorKind}
                          </span>
                          {entry.actorId !== null && (
                            <span
                              className="font-mono text-xs text-[var(--color-muted)]"
                              title={entry.actorId}
                            >
                              {entry.actorId.slice(0, 12)}...
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        {entry.targetKind !== null ? (
                          <div className="flex max-w-[200px] flex-col">
                            <span className="text-sm">{entry.targetKind}</span>
                            {entry.targetRef !== null && (
                              <span
                                className="truncate text-xs text-[var(--color-muted)]"
                                title={entry.targetRef}
                              >
                                {entry.targetRef}
                              </span>
                            )}
                            {entry.targetId !== null && entry.targetRef === null && (
                              <span
                                className="font-mono text-xs text-[var(--color-muted)]"
                                title={entry.targetId}
                              >
                                {entry.targetId.slice(0, 12)}...
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--color-muted)]">--</span>
                        )}
                      </td>
                      <td className="py-3">
                        {entry.ip !== null ? (
                          <code className="font-mono text-xs text-[var(--color-muted)]">
                            {entry.ip}
                          </code>
                        ) : (
                          <span className="text-xs text-[var(--color-muted)]">--</span>
                        )}
                        {entry.requestId !== null && (
                          <div>
                            <code className="font-mono text-[10px] text-[var(--color-muted)]">
                              req:{entry.requestId.slice(0, 8)}
                            </code>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-4">
                <Pagination
                  page={page}
                  totalPages={totalPages}
                  onPageChange={setPage}
                  totalItems={data.total}
                  pageSize={PAGE_SIZE}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* No results for search */}
      {!isLoading && data && data.entries.length > 0 && filteredEntries.length === 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-sm text-[var(--color-muted)]">
              No entries match your search.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
