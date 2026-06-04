'use client';

import useSWR from 'swr';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface Ticket {
  readonly id: string;
  readonly referenceNumber: string;
  readonly subject: string;
  readonly status: string;
  readonly priority: string;
  readonly categoryName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TicketListResponse {
  readonly tickets: readonly Ticket[];
  readonly total: number;
}

/* -------------------------------------------------------------------------- */
/*  Hook                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * SWR hook for the customer's ticket list.
 * Fetches from `/api/customer/tickets` with cookie-based auth.
 *
 * Supports optional status filter to narrow results.
 */
export function useTickets(status?: string) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  const key = `/api/customer/tickets${params.toString() ? '?' + params.toString() : ''}`;

  const { data, error, isLoading, mutate } = useSWR<TicketListResponse>(key);

  return {
    tickets: data?.tickets ?? [],
    total: data?.total ?? 0,
    error,
    isLoading,
    mutate,
  } as const;
}

export type { Ticket, TicketListResponse };
