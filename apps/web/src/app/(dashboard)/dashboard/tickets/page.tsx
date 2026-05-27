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
import { useFirmTickets } from '@/hooks/use-firm-tickets';
import { cn } from '@/lib/utils';

const STATUS_TABS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
] as const;

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export default function FirmTicketsPage() {
  const [activeTab, setActiveTab] = React.useState<string>('all');
  const filters = React.useMemo(
    () => (activeTab === 'all' ? undefined : { status: activeTab }),
    [activeTab],
  );
  const { tickets, isLoading, error } = useFirmTickets(filters);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-[var(--color-fg)]">Support Tickets</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Team inbox, every member sees every ticket opened by your firm.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/tickets/new" className="inline-flex items-center gap-1.5">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Ticket
          </Link>
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          {STATUS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {STATUS_TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value} className="mt-4">
            {error !== undefined && (
              <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
                Failed to load tickets.
              </div>
            )}
            {isLoading ? (
              <ListSkeleton />
            ) : tickets.length === 0 ? (
              <EmptyState
                icon={<TicketIcon className="h-6 w-6" aria-hidden="true" />}
                title="No tickets yet"
                description="Open a ticket and our support team will get back to you."
              />
            ) : (
              <ul className="space-y-2">
                {tickets.map((ticket) => (
                  <li key={ticket.id}>
                    <Link
                      href={`/dashboard/tickets/${ticket.id}`}
                      className={cn(
                        'block rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)]',
                      )}
                    >
                      <Card className="border-0 bg-transparent shadow-none">
                        <CardContent className="p-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-[var(--color-accent)]">
                              {ticket.referenceNumber}
                            </span>
                            <TicketStatusBadge status={ticket.status} />
                            <span className="ml-auto text-xs text-[var(--color-muted)]">
                              <RelativeTime date={ticket.createdAt} />
                            </span>
                          </div>
                          <p className="mt-1 truncate text-sm font-medium text-[var(--color-fg)]">
                            {ticket.subject}
                          </p>
                          <p className="text-xs text-[var(--color-muted)]">
                            {ticket.categoryName}
                            {ticket.creatorEmail !== null && (
                              <>
                                {' · opened by '}
                                {ticket.creatorEmail}
                              </>
                            )}
                          </p>
                        </CardContent>
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
