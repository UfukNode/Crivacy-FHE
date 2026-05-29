'use client';

import * as React from 'react';
import Link from 'next/link';
import { Users, Eye } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/shared/status-badge';
import { KYC_LEVEL_BADGE_MAP, scoreTextClass } from '@/lib/kyc/display';
import { RelativeTime } from '@/components/shared/relative-time';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { SearchInput } from '@/components/shared/search-input';
import { Pagination } from '@/components/shared/pagination';
import { useAdminCustomers, type AdminCustomersFilters } from '@/hooks/use-admin-customers';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'pending_verification', label: 'Pending' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'locked', label: 'Locked' },
  { value: 'banned', label: 'Banned' },
] as const;

const KYC_LEVEL_OPTIONS = [
  { value: '', label: 'All Levels' },
  { value: 'kyc_0', label: 'Unverified (KYC 0)' },
  { value: 'kyc_1', label: 'Registered (KYC 1)' },
  { value: 'kyc_2', label: 'Identity (KYC 2)' },
  { value: 'kyc_3', label: 'Biometric (KYC 3)' },
  { value: 'kyc_4', label: 'Enhanced (KYC 4)' },
] as const;

const STATUS_BADGE_MAP: Record<string, { variant: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; label: string }> = {
  active: { variant: 'success', label: 'Active' },
  pending_verification: { variant: 'info', label: 'Pending' },
  suspended: { variant: 'warning', label: 'Suspended' },
  locked: { variant: 'warning', label: 'Locked' },
  banned: { variant: 'danger', label: 'Banned' },
};

/* -------------------------------------------------------------------------- */
/*  Helper components                                                         */
/* -------------------------------------------------------------------------- */

function CustomerStatusBadge({ status }: { readonly status: string }) {
  const mapping = STATUS_BADGE_MAP[status];
  if (!mapping) {
    return <StatusBadge status="neutral">{status}</StatusBadge>;
  }
  return <StatusBadge status={mapping.variant}>{mapping.label}</StatusBadge>;
}

function CustomerKycBadge({ level }: { readonly level: string }) {
  const mapping = KYC_LEVEL_BADGE_MAP[level];
  if (!mapping) {
    return <StatusBadge status="neutral" dot={false}>{level}</StatusBadge>;
  }
  return <StatusBadge status={mapping.variant} dot={false}>{mapping.label}</StatusBadge>;
}

/* -------------------------------------------------------------------------- */
/*  Filter bar                                                                */
/* -------------------------------------------------------------------------- */

interface FilterBarProps {
  readonly filters: AdminCustomersFilters;
  readonly onFiltersChange: (filters: AdminCustomersFilters) => void;
}

function FilterBar({ filters, onFiltersChange }: FilterBarProps) {
  const selectClasses =
    'min-h-11 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring-color)]';

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      {/* Search */}
      <SearchInput
        value={filters.search ?? ''}
        onChange={(val) => {
          if (val) {
            onFiltersChange({ ...filters, search: val, page: 1 });
          } else {
            const { search: _, ...rest } = filters;
            onFiltersChange({ ...rest, page: 1 });
          }
        }}
        placeholder="Search by email or name..."
        className="w-full sm:w-64"
      />

      {/* Status filter */}
      <label className="sr-only" htmlFor="admin-customer-status-filter">
        Filter by status
      </label>
      <select
        id="admin-customer-status-filter"
        value={filters.status ?? ''}
        onChange={(e) => {
          const val = e.target.value;
          if (val) {
            onFiltersChange({ ...filters, status: val, page: 1 });
          } else {
            const { status: _, ...rest } = filters;
            onFiltersChange({ ...rest, page: 1 });
          }
        }}
        className={selectClasses}
      >
        {STATUS_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* KYC Level filter */}
      <label className="sr-only" htmlFor="admin-customer-kyc-filter">
        Filter by KYC level
      </label>
      <select
        id="admin-customer-kyc-filter"
        value={filters.kycLevel ?? ''}
        onChange={(e) => {
          const val = e.target.value;
          if (val) {
            onFiltersChange({ ...filters, kycLevel: val, page: 1 });
          } else {
            const { kycLevel: _, ...rest } = filters;
            onFiltersChange({ ...rest, page: 1 });
          }
        }}
        className={selectClasses}
      >
        {KYC_LEVEL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Clear filters */}
      {(filters.search || filters.status || filters.kycLevel) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { onFiltersChange({}); }}
        >
          Clear Filters
        </Button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Loading skeleton                                                          */
/* -------------------------------------------------------------------------- */

function AdminCustomersSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Admin customer management page.
 *
 * Shows all customers in a searchable, filterable, paginated table.
 * Filters by account status and KYC level. Each row links to the
 * customer detail page. Displays email, status badges, KYC level,
 * score, last login, and join date.
 */
export default function AdminCustomersPage() {
  const [filters, setFilters] = React.useState<AdminCustomersFilters>({});
  const { customers, total, page, totalPages, error, isLoading, mutate } = useAdminCustomers(filters);

  return (
    <div>
      {/* Header */}
      <PageHeader
        title="Customer Management"
        description="View and manage customer accounts"
        className="mb-6"
      />

      {/* Filters */}
      <div className="mb-4">
        <FilterBar filters={filters} onFiltersChange={setFilters} />
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
          Failed to load customers.
          <Button
            variant="ghost"
            size="sm"
            className="ml-2"
            onClick={() => { void mutate(); }}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <AdminCustomersSkeleton />
      ) : customers.length === 0 ? (
        <EmptyState
          icon={<Users className="h-6 w-6" aria-hidden="true" />}
          title="No customers found"
          description={
            filters.search || filters.status || filters.kycLevel
              ? 'No customers match the current filters.'
              : 'No customers have registered yet.'
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
                    Customer
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
                    KYC Level
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
                    Score
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium text-[var(--color-muted)] md:table-cell">
                    Last Login
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium text-[var(--color-muted)] md:table-cell">
                    Joined
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {customers.map((customer) => (
                  <tr
                    key={customer.id}
                    className="transition-colors hover:bg-[var(--color-surface)]/50"
                  >
                    {/* Customer email + displayName */}
                    <td className="px-4 py-3">
                      <div className="max-w-[220px]">
                        <Link
                          href={`/admin/customers/${customer.id}`}
                          className="text-sm font-medium text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] rounded-[var(--radius-sm)]"
                        >
                          <span className="block truncate">{customer.email ?? customer.displayName ?? 'Wallet User'}</span>
                        </Link>
                        {customer.email !== null && customer.displayName && (
                          <span className="block truncate text-xs text-[var(--color-muted)]">
                            {customer.displayName}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3">
                      <CustomerStatusBadge status={customer.status} />
                    </td>

                    {/* KYC Level */}
                    <td className="px-4 py-3">
                      <CustomerKycBadge level={customer.kycLevel} />
                    </td>

                    {/* Score, coloured by confidence band so a 1000
                        reads as success-green and a low score visually
                        flags. Same band logic as the detail-page chip
                        (see `lib/kyc/display.scoreVariant`). */}
                    <td className={cn('px-4 py-3 font-medium tabular-nums', scoreTextClass(customer.kycScore))}>
                      {customer.kycScore}
                    </td>

                    {/* Last Login */}
                    <td className="hidden whitespace-nowrap px-4 py-3 text-[var(--color-muted)] md:table-cell">
                      {customer.lastLoginAt ? (
                        <RelativeTime date={customer.lastLoginAt} />
                      ) : (
                        <span className="italic text-[var(--color-muted)]/60">Never</span>
                      )}
                    </td>

                    {/* Joined */}
                    <td className="hidden whitespace-nowrap px-4 py-3 text-[var(--color-muted)] md:table-cell">
                      <RelativeTime date={customer.createdAt} />
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/customers/${customer.id}`}
                        className={cn(
                          'inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent)] hover:underline',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] rounded-[var(--radius-sm)]',
                        )}
                      >
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="mt-4">
            <Pagination
              page={page}
              totalPages={totalPages}
              totalItems={total}
              pageSize={filters.limit ?? 20}
              onPageChange={(newPage) => {
                setFilters((prev) => ({ ...prev, page: newPage }));
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
