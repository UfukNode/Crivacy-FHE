'use client';

import useSWR from 'swr';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface TicketCategory {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

interface TicketCategoriesResponse {
  readonly categories: readonly TicketCategory[];
}

/* -------------------------------------------------------------------------- */
/*  Hook                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * SWR hook for available ticket categories.
 * Fetches from `/api/customer/tickets/categories` with cookie-based auth.
 */
export function useTicketCategories() {
  const { data, error, isLoading } = useSWR<TicketCategoriesResponse>(
    '/api/customer/tickets/categories',
  );

  return {
    categories: data?.categories ?? [],
    error,
    isLoading,
  } as const;
}

export type { TicketCategory };
