'use client';

import { useMemo } from 'react';
import useSWR from 'swr';

/**
 * Effective-permission hook for the admin panel. Mirrors
 * `useFirmPermissions` — same shape, same guarantees, same lookup
 * semantics; only the fetch URL differs.
 */
export interface AdminPermissionsHook {
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly permissions: readonly string[];
  readonly has: (code: string) => boolean;
  readonly hasAny: (codes: readonly string[]) => boolean;
  readonly hasAll: (codes: readonly string[]) => boolean;
  readonly role: string | null;
}

interface PermissionsResponse {
  readonly permissions: readonly string[];
  readonly role: string;
}

export function useAdminPermissions(): AdminPermissionsHook {
  const { data, error, isLoading } = useSWR<PermissionsResponse>(
    '/api/internal/admin/me/permissions',
  );

  const permSet = useMemo(() => new Set(data?.permissions ?? []), [data]);

  return useMemo<AdminPermissionsHook>(
    () => ({
      isLoading,
      error: error instanceof Error ? error : error ? new Error(String(error)) : null,
      permissions: data?.permissions ?? [],
      has: (code: string) => permSet.has(code),
      hasAny: (codes: readonly string[]) => codes.some((c) => permSet.has(c)),
      hasAll: (codes: readonly string[]) => codes.every((c) => permSet.has(c)),
      role: data?.role ?? null,
    }),
    [isLoading, error, data, permSet],
  );
}
