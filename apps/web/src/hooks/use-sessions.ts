'use client';

import useSWR from 'swr';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface SessionEntry {
  readonly id: string;
  readonly deviceName: string | null;
  readonly city: string | null;
  readonly ip: string | null;
  readonly lastActiveAt: string;
  readonly isCurrent: boolean;
}

interface SessionsResponse {
  readonly sessions: readonly SessionEntry[];
}

/* -------------------------------------------------------------------------- */
/*  Hook                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * SWR hook for the customer's active sessions.
 * Fetches from `/api/customer/sessions` with cookie-based auth.
 */
export function useSessions() {
  const { data, error, isLoading, mutate } = useSWR<SessionsResponse>(
    '/api/customer/sessions',
  );

  return {
    sessions: data?.sessions ?? [],
    error,
    isLoading,
    mutate,
  } as const;
}
