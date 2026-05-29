'use client';

import { EmptyState } from '@/components/shared/empty-state';
import { RelativeTime } from '@/components/shared/relative-time';
import { SearchInput } from '@/components/shared/search-input';
import { TicketPriorityBadge } from '@/components/shared/ticket-priority-badge';
import { TicketStatusBadge } from '@/components/shared/ticket-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  type AdminTicketsFilters,
  type AdminTicketView,
  useAdminTickets,
} from '@/hooks/use-admin-tickets';
import { useAdminPermissions } from '@/hooks/use-admin-permissions';
import { Ticket as TicketIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Radix Select forbids empty-string item values, so the "All …" options use
 * a non-empty sentinel that we translate back to "no filter" when updating
 * the filters object.
 */
const ALL_VALUE = '__all__';

const STATUS_OPTIONS = [
  { value: ALL_VALUE, label: 'All Statuses' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'waiting_customer', label: 'Waiting Customer' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
] as const;

const PRIORITY_OPTIONS = [
  { value: ALL_VALUE, label: 'All Priorities' },
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
] as const;

const VIEW_TABS = [
  {
    value: 'inbox',
    label: 'Inbox',
    hint: 'Tickets assigned to you or where you collaborate.',
  },
  {
    value: 'invites',
    label: 'Invites',
    hint: 'Pending invitations awaiting your response.',
  },
  {
    value: 'team',
    label: 'Team',
    hint: 'Tickets in categories where you are a team member.',
  },
  {
    value: 'all',
    label: 'All',
    hint: 'Every ticket you can see.',
  },
] as const satisfies readonly {
  readonly value: AdminTicketView;
  readonly label: string;
  readonly hint: string;
}[];

const VALID_VIEWS: readonly AdminTicketView[] = VIEW_TABS.map((tab) => tab.value);

function parseView(raw: string | null): AdminTicketView {
  if (raw !== null && (VALID_VIEWS as readonly string[]).includes(raw)) {
    return raw as AdminTicketView;
  }
  return 'inbox';
}

/* -------------------------------------------------------------------------- */
/*  Tab bar                                                                   */
/* -------------------------------------------------------------------------- */

interface ViewTabsProps {
  readonly current: AdminTicketView;
  readonly pendingInvitesCount: number;
  readonly onChange: (next: AdminTicketView) => void;
}

function ViewTabs({ current, pendingInvitesCount, onChange }: ViewTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Ticket view"
      className="flex items-center gap-1 border-b border-[var(--color-border)]"
    >
      {VIEW_TABS.map((tab) => {
        const active = tab.value === current;
        const showBadge = tab.value === 'invites' && pendingInvitesCount > 0;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={tab.hint}
            onClick={() => {
              onChange(tab.value);
            }}
            className={cn(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)]',
              active
                ? 'border-[var(--color-accent)] text-[var(--color-fg)]'
                : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)]',
            )}
          >
            {tab.label}
            {showBadge && (
              <Badge
                variant="warning"
                className="h-5 min-w-[1.25rem] justify-center px-1.5 py-0 text-[10px] leading-4"
                aria-label={`${pendingInvitesCount} pending invitations`}
              >
                {pendingInvitesCount}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Filter bar                                                                */
/* -------------------------------------------------------------------------- */

interface FilterBarProps {
  readonly filters: AdminTicketsFilters;
  readonly onFiltersChange: (filters: AdminTicketsFilters) => void;
}

function FilterBar({ filters, onFiltersChange }: FilterBarProps) {
  const handleSearchChange = React.useCallback(
    (value: string) => {
      if (value) {
        onFiltersChange({ ...filters, search: value });
      } else {
        const { search: _, ...rest } = filters;
        onFiltersChange(rest);
      }
    },
    [filters, onFiltersChange],
  );

  const handleStatusChange = React.useCallback(
    (value: string) => {
      if (value === ALL_VALUE) {
        const { status: _, ...rest } = filters;
        onFiltersChange(rest);
      } else {
        onFiltersChange({ ...filters, status: value });
      }
    },
    [filters, onFiltersChange],
  );

  const handlePriorityChange = React.useCallback(
    (value: string) => {
      if (value === ALL_VALUE) {
        const { priority: _, ...rest } = filters;
        onFiltersChange(rest);
      } else {
        onFiltersChange({ ...filters, priority: value });
      }
    },
    [filters, onFiltersChange],
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Search */}
      <SearchInput
        value={filters.search ?? ''}
        onChange={handleSearchChange}
        placeholder="Search reference, subject, customer…"
        className="w-full sm:w-80"
      />

      {/* Status filter */}
      <label className="sr-only" htmlFor="admin-ticket-status-filter">
        Filter by status
      </label>
      <Select value={filters.status ?? ALL_VALUE} onValueChange={handleStatusChange}>
        <SelectTrigger id="admin-ticket-status-filter" className="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Priority filter */}
      <label className="sr-only" htmlFor="admin-ticket-priority-filter">
        Filter by priority
      </label>
      <Select value={filters.priority ?? ALL_VALUE} onValueChange={handlePriorityChange}>
        <SelectTrigger id="admin-ticket-priority-filter" className="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRIORITY_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Clear filters */}
      {(filters.status || filters.priority || filters.search) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            // Keep view; only clear user-applied filters.
            const { view } = filters;
            onFiltersChange(view !== undefined ? { view } : {});
          }}
        >
          Clear Filters
        </Button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Role indicator                                                            */
/* -------------------------------------------------------------------------- */

interface RoleIndicatorProps {
  readonly role: 'assignee' | 'collaborator' | null;
  readonly status: 'active' | 'pending' | null;
}

function RoleIndicator({ role, status }: RoleIndicatorProps) {
  if (role === null || status === null) {
    return null;
  }

  // Pending > role, surface the decision-required state first.
  if (status === 'pending') {
    return (
      <Badge
        variant="warning"
        className="h-5 px-1.5 py-0 text-[10px] leading-4"
        aria-label="Pending invitation"
        title="Pending invitation, accept or decline on the ticket page."
      >
        Pending
      </Badge>
    );
  }

  const label = role === 'assignee' ? 'Assignee' : 'Collab';
  return (
    <Badge
      variant={role === 'assignee' ? 'default' : 'secondary'}
      className="h-5 px-1.5 py-0 text-[10px] leading-4"
      aria-label={role === 'assignee' ? 'You are the assignee' : 'You collaborate on this ticket'}
      title={role === 'assignee' ? 'You are the assignee.' : 'You collaborate on this ticket.'}
    >
      {label}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/*  Loading skeleton                                                          */
/* -------------------------------------------------------------------------- */

function AdminTicketsSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Admin ticket management page.
 *
 * Tab-scoped view with URL-synced state (`?view=inbox|invites|team|all`).
 * Filters (status, priority, search) are local-only so they don't pollute
 * shareable URLs. The pending-invites badge on the "Invites" tab reflects
 * the caller's own count, independent of the current view.
 */
export default function AdminTicketsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const view = parseView((searchParams?.get('view') ?? null));

  const [filters, setFilters] = React.useState<AdminTicketsFilters>({});

  const effectiveFilters = React.useMemo<AdminTicketsFilters>(
    () => ({ ...filters, view }),
    [filters, view],
  );

  const { tickets, total, pendingInvitesCount, error, isLoading, mutate } =
    useAdminTickets(effectiveFilters);

  // Category management is Admin+ only. Support admins still see the
  // ticket list (read_all covers them) but not the categories link.
  const { has: hasAdminPermission } = useAdminPermissions();
  const canManageCategories = hasAdminPermission('admin.ticket.category_manage');

  const setView = React.useCallback(
    (next: AdminTicketView) => {
      const params = new URLSearchParams(searchParams?.toString());
      params.set('view', next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // First-load: normalise URL so the view is always explicit in the query
  // string. Makes the selected tab survive refresh / deep-link / share.
  React.useEffect(() => {
    if ((searchParams?.get('view') ?? null) === null) {
      const params = new URLSearchParams(searchParams?.toString());
      params.set('view', view);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
    // Only runs once on mount; URL mutations after that are user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Row click handler, navigate to ticket detail.
   *
   * Skips navigation when the click originates inside a nested `<a>` or
   * `<button>` so the inner Link/button handles its own behavior (including
   * middle-click, right-click, and modifier-key new-tab opens). Falls back to
   * `window.open` when the user holds Ctrl/⌘/middle so the row click matches
   * standard link semantics for keyboard power users.
   */
  const handleRowClick = React.useCallback(
    (ticketId: string, e: React.MouseEvent<HTMLTableRowElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest('a, button')) return;
      const href = `/admin/tickets/${ticketId}`;
      if (e.metaKey || e.ctrlKey || e.button === 1) {
        window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      router.push(href);
    },
    [router],
  );

  const handleRowKeyDown = React.useCallback(
    (ticketId: string, e: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const target = e.target as HTMLElement;
        if (target.closest('a, button')) return;
        e.preventDefault();
        router.push(`/admin/tickets/${ticketId}`);
      }
    },
    [router],
  );

  const emptyDescription =
    filters.status || filters.priority || filters.search
      ? 'No tickets match the current filters.'
      : view === 'inbox'
        ? 'You have no tickets where you are the assignee or an active collaborator.'
        : view === 'invites'
          ? 'You have no pending invitations.'
          : view === 'team'
            ? "No tickets in categories you're a member of."
            : 'No tickets have been created yet.';

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-fg)]">
          Tickets ({total})
        </h1>
        {canManageCategories && (
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/tickets/categories">Manage Categories</Link>
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4">
        <ViewTabs
          current={view}
          pendingInvitesCount={pendingInvitesCount}
          onChange={setView}
        />
      </div>

      {/* Filters */}
      <div className="mb-4">
        <FilterBar filters={filters} onFiltersChange={setFilters} />
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
          Failed to load tickets.
          <Button
            variant="ghost"
            size="sm"
            className="ml-2"
            onClick={() => {
              void mutate();
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <AdminTicketsSkeleton />
      ) : tickets.length === 0 ? (
        <EmptyState
          icon={<TicketIcon className="h-6 w-6" aria-hidden="true" />}
          title="No tickets found"
          description={emptyDescription}
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
              <tr>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium text-[var(--color-muted)]">
                  Reference
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium text-[var(--color-muted)]">
                  Subject
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium text-[var(--color-muted)]">
                  Opened by
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium text-[var(--color-muted)]">
                  Status
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium text-[var(--color-muted)]">
                  Priority
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium text-[var(--color-muted)]">
                  Category
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium text-[var(--color-muted)]">
                  Assigned To
                </th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium text-[var(--color-muted)]">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {tickets.map((ticket) => (
                <tr
                  key={ticket.id}
                  tabIndex={0}
                  aria-label={`Open ticket ${ticket.referenceNumber}`}
                  onClick={(e) => {
                    handleRowClick(ticket.id, e);
                  }}
                  onKeyDown={(e) => {
                    handleRowKeyDown(ticket.id, e);
                  }}
                  className="cursor-pointer transition-colors hover:bg-[var(--color-surface)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)]"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/admin/tickets/${ticket.id}`}
                        className="font-mono text-xs text-[var(--color-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] rounded-[var(--radius-sm)]"
                      >
                        {ticket.referenceNumber}
                      </Link>
                      <RoleIndicator
                        role={ticket.viewerParticipantRole}
                        status={ticket.viewerParticipantStatus}
                      />
                    </div>
                  </td>
                  <td className="max-w-[200px] truncate px-4 py-3 font-medium text-[var(--color-fg)]">
                    {ticket.subject}
                  </td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <div className="min-w-0 max-w-[180px] truncate">
                        {ticket.creator.label}
                      </div>
                      {ticket.creator.kind === 'firm_user' && (
                        <span
                          className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]"
                          title={
                            ticket.creator.firmTier !== null
                              ? `Firm ticket (${ticket.creator.firmTier} tier)`
                              : 'Firm ticket'
                          }
                        >
                          Firm
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <TicketStatusBadge status={ticket.status} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <TicketPriorityBadge priority={ticket.priority} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-[var(--color-muted)]">
                    {ticket.categoryName}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-[var(--color-muted)]">
                    {ticket.assignedToName ?? (
                      <span className="italic text-[var(--color-muted)]/60">Unassigned</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-[var(--color-muted)]">
                    <RelativeTime date={ticket.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
