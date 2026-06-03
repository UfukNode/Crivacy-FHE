'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface PaginationProps {
  /** Current page (1-indexed) */
  page: number;
  /** Total number of pages */
  totalPages: number;
  /** Called with new page number */
  onPageChange: (page: number) => void;
  /** Total items count (optional, shown as "Showing X-Y of Z") */
  totalItems?: number;
  /** Items per page (for computing displayed range) */
  pageSize?: number;
  className?: string;
}

/**
 * Pagination controls with page numbers.
 * Shows: prev, page numbers (with ellipsis), next, and item count.
 */
export function Pagination({
  page,
  totalPages,
  onPageChange,
  totalItems,
  pageSize = 20,
  className,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages = React.useMemo(() => {
    const result: (number | 'ellipsis')[] = [];
    const delta = 1; // Pages around current

    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= page - delta && i <= page + delta)) {
        result.push(i);
      } else if (result[result.length - 1] !== 'ellipsis') {
        result.push('ellipsis');
      }
    }

    return result;
  }, [page, totalPages]);

  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, totalItems ?? page * pageSize);

  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      {totalItems !== undefined && (
        <p className="text-sm text-[var(--color-muted)]">
          Showing {startItem}-{endItem} of {totalItems}
        </p>
      )}
      <nav className="flex items-center gap-1" aria-label="Pagination">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>

        {pages.map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`ellipsis-${i}`} className="px-2 text-sm text-[var(--color-muted)]">
              ...
            </span>
          ) : (
            <Button
              key={p}
              variant={p === page ? 'default' : 'outline'}
              size="icon"
              className="h-8 w-8 text-xs"
              onClick={() => onPageChange(p)}
              aria-label={`Page ${p}`}
              aria-current={p === page ? 'page' : undefined}
            >
              {p}
            </Button>
          ),
        )}

        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </nav>
    </div>
  );
}
