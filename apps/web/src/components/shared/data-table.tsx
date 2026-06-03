'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ArrowUpDown, ArrowUp, ArrowDown, Search, ChevronLeft, ChevronRight } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Column<T> {
  /** Unique key for this column, used as object key accessor when render is not provided. */
  key: string;
  /** Display header label. */
  header: string;
  /** Whether this column can be sorted. */
  sortable?: boolean;
  /** Custom cell renderer. Falls back to `String(row[key])` if not provided. */
  render?: (row: T) => React.ReactNode;
  /** Additional CSS class for the cell. */
  className?: string;
}

type SortDirection = 'asc' | 'desc';

interface SortState {
  key: string;
  direction: SortDirection;
}

interface DataTableProps<T> {
  /** Column definitions. */
  columns: Column<T>[];
  /** Row data array. */
  data: T[];
  /** Show loading skeletons. */
  isLoading?: boolean;
  /** Placeholder text for the search input. */
  searchPlaceholder?: string;
  /** Controlled search handler (server-side search). */
  onSearch?: (query: string) => void;
  /** Controlled search value. */
  searchValue?: string;
  /** Controlled sort state. */
  sort?: SortState;
  /** Called when a sortable column header is clicked. */
  onSort?: (sort: SortState) => void;
  /** Current page number (1-based). */
  page?: number;
  /** Rows per page. */
  pageSize?: number;
  /** Total row count (for pagination display). */
  totalCount?: number;
  /** Called when page changes. */
  onPageChange?: (page: number) => void;
  /** Icon for the empty state. */
  emptyIcon?: React.ReactNode;
  /** Title for the empty state. */
  emptyTitle?: string;
  /** Description for the empty state. */
  emptyDescription?: string;
  /** Action element for the empty state (e.g. a button). */
  emptyAction?: React.ReactNode;
  /** Called when a row is clicked. */
  onRowClick?: (row: T) => void;
  /** Returns a unique ID for each row (for React keys). */
  getRowId?: (row: T) => string;
}

// ---------------------------------------------------------------------------
// Debounced search hook
// ---------------------------------------------------------------------------

function useDebouncedCallback(callback: (value: string) => void, delay: number) {
  const callbackRef = React.useRef(callback);
  callbackRef.current = callback;

  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  return React.useCallback(
    (value: string) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        callbackRef.current(value);
      }, delay);
    },
    [delay],
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SortIcon({ columnKey, sort }: { readonly columnKey: string; readonly sort?: SortState }) {
  if (!sort || sort.key !== columnKey) {
    return <ArrowUpDown className="ml-1 inline h-3.5 w-3.5 text-[var(--color-muted)]" aria-hidden="true" />;
  }
  if (sort.direction === 'asc') {
    return <ArrowUp className="ml-1 inline h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />;
  }
  return <ArrowDown className="ml-1 inline h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// DataTable
// ---------------------------------------------------------------------------

/**
 * Reusable data table with search, sort, pagination, loading, and empty states.
 *
 * Desktop renders as a standard HTML table; mobile (< md) renders each
 * row as a stacked card with label: value pairs.
 */
export function DataTable<T>({
  columns,
  data,
  isLoading = false,
  searchPlaceholder = 'Search...',
  onSearch,
  searchValue,
  sort,
  onSort,
  page = 1,
  pageSize = 20,
  totalCount,
  onPageChange,
  emptyIcon,
  emptyTitle = 'No results found',
  emptyDescription,
  emptyAction,
  onRowClick,
  getRowId,
}: DataTableProps<T>) {
  // Debounced search
  const [localSearch, setLocalSearch] = React.useState(searchValue ?? '');
  const debouncedSearch = useDebouncedCallback((value: string) => {
    onSearch?.(value);
  }, 300);

  // Sync external searchValue into local state
  React.useEffect(() => {
    if (searchValue !== undefined) {
      setLocalSearch(searchValue);
    }
  }, [searchValue]);

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setLocalSearch(value);
    debouncedSearch(value);
  }

  function handleSort(columnKey: string) {
    if (!onSort) return;
    if (sort?.key === columnKey) {
      // Toggle direction
      onSort({
        key: columnKey,
        direction: sort.direction === 'asc' ? 'desc' : 'asc',
      });
    } else {
      onSort({ key: columnKey, direction: 'asc' });
    }
  }

  // Pagination calculations
  const effectiveTotal = totalCount ?? data.length;
  const totalPages = Math.max(1, Math.ceil(effectiveTotal / pageSize));
  const showPagination = onPageChange && effectiveTotal > 0;

  function getCellValue(row: T, col: Column<T>): React.ReactNode {
    if (col.render) return col.render(row);
    const value = (row as Record<string, unknown>)[col.key];
    if (value === null || value === undefined) return '\u2014';
    return String(value);
  }

  function getRowKey(row: T, index: number): string {
    if (getRowId) return getRowId(row);
    const id = (row as Record<string, unknown>)['id'];
    if (typeof id === 'string') return id;
    if (typeof id === 'number') return String(id);
    return String(index);
  }

  // -------------------------------------------------------------------------
  // Loading skeleton
  // -------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="space-y-4">
        {/* Search skeleton */}
        {onSearch && <Skeleton className="h-10 w-full max-w-sm" />}

        {/* Desktop: table skeleton */}
        <div className="hidden md:block">
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {/* Header */}
            <div className="flex gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
              {columns.map((col) => (
                <Skeleton key={col.key} className="h-4 flex-1" />
              ))}
            </div>
            {/* Rows */}
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex gap-4 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0">
                {columns.map((col) => (
                  <Skeleton key={col.key} className="h-4 flex-1" />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Mobile: card skeletons */}
        <div className="space-y-3 md:hidden">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 space-y-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ))}
        </div>

        {/* Pagination skeleton */}
        {showPagination && <Skeleton className="mx-auto h-8 w-48" />}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  if (data.length === 0 && !isLoading) {
    return (
      <div className="space-y-4">
        {/* Search input (even in empty state, user may want to clear search) */}
        {onSearch && (
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden="true" />
            <Input
              value={localSearch}
              onChange={handleSearchChange}
              placeholder={searchPlaceholder}
              className="pl-9"
              aria-label={searchPlaceholder}
            />
          </div>
        )}

        <div className="flex flex-col items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] py-16 text-center">
          {emptyIcon && <div className="mb-4 text-[var(--color-muted)]">{emptyIcon}</div>}
          <p className="text-sm font-medium text-[var(--color-fg)]">{emptyTitle}</p>
          {emptyDescription && (
            <p className="mt-1 max-w-sm text-xs text-[var(--color-muted)]">{emptyDescription}</p>
          )}
          {emptyAction && <div className="mt-4">{emptyAction}</div>}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* Search input */}
      {onSearch && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden="true" />
          <Input
            value={localSearch}
            onChange={handleSearchChange}
            placeholder={searchPlaceholder}
            className="pl-9"
            aria-label={searchPlaceholder}
          />
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden md:block">
        <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
          <table className="w-full text-sm" role="table">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={cn(
                      'px-4 py-3 text-left text-xs font-medium text-[var(--color-muted)]',
                      col.sortable && 'cursor-pointer select-none hover:text-[var(--color-fg)]',
                      col.className,
                    )}
                    onClick={col.sortable ? () => { handleSort(col.key); } : undefined}
                    aria-sort={
                      sort?.key === col.key
                        ? sort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                    scope="col"
                  >
                    {col.header}
                    {col.sortable && <SortIcon columnKey={col.key} {...(sort !== undefined ? { sort } : {})} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, index) => (
                <tr
                  key={getRowKey(row, index)}
                  className={cn(
                    'border-b border-[var(--color-border)] last:border-b-0 transition-colors',
                    onRowClick
                      ? 'cursor-pointer hover:bg-[var(--color-surface-hover)]'
                      : '',
                  )}
                  onClick={onRowClick ? () => { onRowClick(row); } : undefined}
                  role={onRowClick ? 'button' : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((col) => (
                    <td key={col.key} className={cn('px-4 py-3 text-[var(--color-fg)]', col.className)}>
                      {getCellValue(row, col)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile card layout */}
      <div className="space-y-3 md:hidden">
        {data.map((row, index) => (
          <div
            key={getRowKey(row, index)}
            className={cn(
              'rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-4 space-y-2',
              onRowClick ? 'cursor-pointer active:bg-[var(--color-surface-hover)]' : '',
            )}
            onClick={onRowClick ? () => { onRowClick(row); } : undefined}
            role={onRowClick ? 'button' : undefined}
            tabIndex={onRowClick ? 0 : undefined}
            onKeyDown={
              onRowClick
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onRowClick(row);
                    }
                  }
                : undefined
            }
          >
            {columns.map((col) => (
              <div key={col.key} className="flex items-start justify-between gap-2">
                <span className="text-xs font-medium text-[var(--color-muted)] shrink-0">
                  {col.header}
                </span>
                <span className={cn('text-sm text-[var(--color-fg)] text-right break-words min-w-0', col.className)}>
                  {getCellValue(row, col)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Pagination */}
      {showPagination && (
        <div className="flex items-center justify-between border-t border-[var(--color-border)] px-1 pt-4">
          <p className="text-xs text-[var(--color-muted)]">
            {effectiveTotal > 0
              ? `${(page - 1) * pageSize + 1}\u2013${Math.min(page * pageSize, effectiveTotal)} of ${effectiveTotal}`
              : '0 results'}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { onPageChange(page - 1); }}
              disabled={page <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:ml-1">Previous</span>
            </Button>
            <span className="px-2 text-xs text-[var(--color-muted)]">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { onPageChange(page + 1); }}
              disabled={page >= totalPages}
              aria-label="Next page"
            >
              <span className="sr-only sm:not-sr-only sm:mr-1">Next</span>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export type { Column, SortState, SortDirection, DataTableProps };
