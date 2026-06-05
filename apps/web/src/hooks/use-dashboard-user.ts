'use client';

import useSWR from 'swr';

export interface DashboardUserData {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly firmId: string;
  readonly firmName: string;
}

/**
 * SWR hook for the authenticated dashboard user.
 * Fetches from `/api/internal/me` with cookie-based auth.
 */
export function useDashboardUser() {
  const { data, error, isLoading } = useSWR<DashboardUserData>(
    '/api/internal/me',
  );

  return {
    user: data ?? null,
    error,
    isLoading,
  } as const;
}
