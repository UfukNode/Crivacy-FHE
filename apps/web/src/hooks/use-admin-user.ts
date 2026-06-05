'use client';

import useSWR from 'swr';

export interface AdminUserData {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
}

/**
 * SWR hook for the authenticated admin user.
 * Fetches from `/api/internal/admin/me` with cookie-based auth.
 */
export function useAdminUser() {
  const { data, error, isLoading } = useSWR<AdminUserData>(
    '/api/internal/admin/me',
  );

  return {
    user: data ?? null,
    error,
    isLoading,
  } as const;
}
