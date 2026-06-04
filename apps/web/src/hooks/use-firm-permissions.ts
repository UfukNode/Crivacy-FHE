'use client';

import { useMemo } from 'react';
import useSWR from 'swr';

/**
 * Effective-permission hook for the firm dashboard.
 *
 * Fetches `/api/internal/me/permissions` via SWR (portal fetcher auto-
 * refreshes tokens on 401, redirects to login on session expiry). The
 * response shape is `{ permissions: string[], role: string }`; this
 * hook wraps it in a `Set` for O(1) lookup and exposes a small
 * imperative API so callers never branch on `undefined`:
 *
 *   const { has, permissions, isLoading } = useFirmPermissions();
 *   const canDeleteWebhook = has('webhook.delete');
 *
 * SWR caches the response across the tree, so mounting ten buttons
 * that each call `useFirmPermissions()` produces a single network
 * request. Revalidation on focus + reconnect is inherited from the
 * portal SWRConfig wrapping `(dashboard)/layout.tsx`.
 *
 * Loading semantics: `has(...)` returns `false` while the fetch is
 * in-flight. Components that need a "hide until loaded" pattern should
 * check `isLoading` and render a skeleton, otherwise a brief flash of
 * disabled buttons appears on first paint.
 */
export interface FirmPermissionsHook {
  /** Whether SWR has returned at least one successful response. */
  readonly isLoading: boolean;
  /** Fetch error, if any. Includes HTTP status + body info. */
  readonly error: Error | null;
  /** The flat permission code array (sorted). Empty while loading. */
  readonly permissions: readonly string[];
  /** O(1) lookup — returns `false` during load. */
  readonly has: (code: string) => boolean;
  /** ANY-of check — true when at least one code matches. */
  readonly hasAny: (codes: readonly string[]) => boolean;
  /** ALL-of check — true only when every code matches. */
  readonly hasAll: (codes: readonly string[]) => boolean;
  /** Role display string (e.g. 'admin', 'owner'). `null` while loading. */
  readonly role: string | null;
}

interface PermissionsResponse {
  readonly permissions: readonly string[];
  readonly role: string;
}

export function useFirmPermissions(): FirmPermissionsHook {
  const { data, error, isLoading } = useSWR<PermissionsResponse>(
    '/api/internal/me/permissions',
  );

  // Memoise the Set so consumers that destructure `has` don't see a
  // new reference on every render — preventing unnecessary downstream
  // `useMemo` / `useEffect` invalidations.
  const permSet = useMemo(() => new Set(data?.permissions ?? []), [data]);

  return useMemo<FirmPermissionsHook>(
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
