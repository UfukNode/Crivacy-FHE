'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus, Ticket as TicketIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { EmptyState } from '@/components/shared/empty-state';
import { TicketStatusBadge } from '@/components/shared/ticket-status-badge';
import { RelativeTime } from '@/components/shared/relative-time';
import { useTickets } from '@/hooks/use-tickets';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const STATUS_TABS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
] as const;

/* -------------------------------------------------------------------------- */
/*  Loading skeleton                                                          */
/* -------------------------------------------------------------------------- */

function TicketListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-24 w-full" />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Error banner                                                              */
/* -------------------------------------------------------------------------- */

interface ErrorBannerProps {
  readonly message: string;
  readonly onRetry: () => void;
}

function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-4">
      <p className="text-sm text-[var(--color-danger)]">{message}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Ticket card                                                               */
/* -------------------------------------------------------------------------- */

interface TicketCardProps {
  readonly id: string;
  readonly referenceNumber: string;
  readonly subject: string;
  readonly status: string;
  readonly categoryName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function TicketCard({
  id,
  referenceNumber,
  subject,
  status,
  categoryName,
  createdAt,
  updatedAt,
}: TicketCardProps) {
  return (
    <Link
      href={`/tickets/${id}`}
      className="block transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] rounded-[var(--radius-lg)]"
      aria-label={`View ticket ${referenceNumber}: ${subject}`}
    >
      <Card className="hover:border-[var(--color-accent)]/50 transition-colors duration-[var(--duration-base)]">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="shrink-0 font-mono text-xs text-[var(--color-muted)]">
                  {referenceNumber}
                </span>
                <TicketStatusBadge status={status} />
              </div>
              <h3 className="truncate text-sm font-medium text-[var(--color-fg)]">
                {subject}
              </h3>
              <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
                <span>{categoryName}</span>
                <span aria-hidden="true">&middot;</span>
                <span>
                  Created <RelativeTime date={createdAt} />
                </span>
                {updatedAt !== createdAt && (
                  <>
                    <span aria-hidden="true">&middot;</span>
                    <span>
                      Updated <RelativeTime date={updatedAt} />
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/*  Ticket list for a given status tab                                        */
/* -------------------------------------------------------------------------- */

interface TicketListContentProps {
  readonly statusFilter: string | undefined;
}

function TicketListContent({ statusFilter }: TicketListContentProps) {
  const { tickets, error, isLoading, mutate } = useTickets(statusFilter);

  if (isLoading) {
    return <TicketListSkeleton />;
  }

  if (error) {
    return (
      <ErrorBanner
        message="Failed to load tickets. Please try again."
        onRetry={() => { void mutate(); }}
      />
    );
  }

  if (tickets.length === 0) {
    return (
      <EmptyState
        icon={<TicketIcon className="h-6 w-6" aria-hidden="true" />}
        title="No tickets yet"
        description={
          statusFilter
            ? `You have no ${statusFilter.replace(/_/g, ' ')} tickets.`
            : 'Create your first support ticket to get started.'
        }
        action={
          !statusFilter ? (
            <Button asChild>
              <Link href="/tickets/new">Create Your First Ticket</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-3" role="list" aria-label="Ticket list">
      {tickets.map((ticket) => (
        <div key={ticket.id} role="listitem">
          <TicketCard
            id={ticket.id}
            referenceNumber={ticket.referenceNumber}
            subject={ticket.subject}
            status={ticket.status}
            categoryName={ticket.categoryName}
            createdAt={ticket.createdAt}
            updatedAt={ticket.updatedAt}
          />
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Customer support tickets page.
 *
 * Displays the ticket list filtered by status tabs (All, Open, In Progress,
 * Resolved, Closed). Each ticket card links to the detail page.
 * Includes a "New Ticket" button in the header.
 */
export default function TicketsPage() {
  const [activeTab, setActiveTab] = React.useState('all');

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-[var(--color-fg)]">Support Tickets</h1>
          <p className="text-sm text-[var(--color-muted)]">
            View and manage your support requests.
          </p>
        </div>
        <Button asChild className="shrink-0">
          <Link href="/tickets/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Ticket
          </Link>
        </Button>
      </div>

      {/* Filter tabs + ticket list */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-4"
      >
        <TabsList className={cn('flex-wrap')}>
          {STATUS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {STATUS_TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            <TicketListContent
              statusFilter={tab.value === 'all' ? undefined : tab.value}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
