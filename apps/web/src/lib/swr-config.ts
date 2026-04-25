/**
 * Portal-specific SWR configuration factory with auto token refresh.
 *
 * Each portal (customer, dashboard, admin) gets its own SWR fetcher that
 * refreshes tokens via the correct endpoint and redirects to the correct
 * login page on session expiry. A per-config mutex prevents concurrent
 * refresh races.
 *
 * @module
 */

import type { SWRConfiguration } from 'swr';

// ---------------------------------------------------------------------------
// Shared error retry logic (same for all portals)
// ---------------------------------------------------------------------------

const SHARED_SWR_OPTIONS: Partial<SWRConfiguration> = {
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  shouldRetryOnError: true,
  errorRetryCount: 5,
  dedupingInterval: 2000,

  onErrorRetry: (error, _key, _config, revalidate, { retryCount }) => {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) return;
    if (retryCount >= 5) return;
    const delay = Math.min(2 ** retryCount * 1000, 30000);
    setTimeout(() => revalidate({ retryCount }), delay);
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createFetchError(res: Response): Error & { status: number; info: unknown } {
  const error = new Error('Fetch error') as Error & { status: number; info: unknown };
  error.status = res.status;
  error.info = null;
  return error;
}

/**
 * Create a portal-specific SWR configuration.
 *
 * @param refreshEndpoint - The API endpoint to call for token refresh (e.g. `/api/customer/auth/refresh`)
 * @param loginPath - Where to redirect on session expiry (e.g. `/login`, `/dashboard/login`, `/admin/login`)
 */
export function createPortalSwrConfig(
  refreshEndpoint: string,
  loginPath: string,
): SWRConfiguration {
  // Per-portal mutex — each portal has its own refresh-in-flight promise
  let refreshPromise: Promise<boolean> | null = null;

  async function refreshAccessToken(): Promise<boolean> {
    if (refreshPromise !== null) return refreshPromise;

    refreshPromise = (async () => {
      try {
        const res = await fetch(refreshEndpoint, {
          method: 'POST',
          credentials: 'include',
        });
        return res.ok;
      } catch {
        return false;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  /** Tracks whether a redirect is already in progress to prevent loops. */
  let redirecting = false;

  function redirectToLogin(reason: string = 'session_expired'): void {
    if (typeof window === 'undefined') return;

    // Already on the login page — don't redirect to self (prevents infinite loop)
    if (window.location.pathname === loginPath) return;

    // A redirect is already in progress — don't stack another one
    if (redirecting) return;
    redirecting = true;

    const current = window.location.pathname;
    window.location.href = `${loginPath}?from=${encodeURIComponent(current)}&reason=${reason}`;
  }

  async function fetchWithAutoRefresh(url: string): Promise<unknown> {
    const res = await fetch(url, { credentials: 'include' });

    if (res.ok) return res.json();

    if (res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        const retryRes = await fetch(url, { credentials: 'include' });
        if (retryRes.ok) return retryRes.json();
        redirectToLogin();
        throw createFetchError(retryRes);
      }
      redirectToLogin();
      throw createFetchError(res);
    }

    throw createFetchError(res);
  }

  return {
    ...SHARED_SWR_OPTIONS,
    fetcher: fetchWithAutoRefresh,
  };
}

// ---------------------------------------------------------------------------
// Pre-built portal configs
// ---------------------------------------------------------------------------

/** Customer portal SWR config — refreshes via /api/customer/auth/refresh, redirects to /login */
export const customerSwrConfig: SWRConfiguration = createPortalSwrConfig(
  '/api/customer/auth/refresh',
  '/login',
);

/** Dashboard portal SWR config — refreshes via /api/internal/auth/refresh, redirects to /dashboard/login */
export const dashboardSwrConfig: SWRConfiguration = createPortalSwrConfig(
  '/api/internal/auth/refresh',
  '/dashboard/login',
);

/** Admin portal SWR config — refreshes via /api/internal/admin/auth/refresh, redirects to /admin/login */
export const adminSwrConfig: SWRConfiguration = createPortalSwrConfig(
  '/api/internal/admin/auth/refresh',
  '/admin/login',
);

// ---------------------------------------------------------------------------
// Proactive refresh (per-portal)
// ---------------------------------------------------------------------------

const proactiveIntervals = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Start a proactive refresh timer for a specific portal.
 * Runs every 13 minutes (access token is 15 min), but only when the tab is visible.
 */
export function startProactiveRefresh(
  portalKey: string,
  refreshEndpoint: string,
): void {
  if (typeof window === 'undefined') return;
  if (proactiveIntervals.has(portalKey)) return;

  const REFRESH_INTERVAL_MS = 13 * 60 * 1000;

  const intervalId = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void fetch(refreshEndpoint, { method: 'POST', credentials: 'include' });
  }, REFRESH_INTERVAL_MS);

  proactiveIntervals.set(portalKey, intervalId);
}

/**
 * Stop the proactive refresh timer for a specific portal (e.g. on logout).
 */
export function stopProactiveRefresh(portalKey: string): void {
  const intervalId = proactiveIntervals.get(portalKey);
  if (intervalId !== undefined) {
    clearInterval(intervalId);
    proactiveIntervals.delete(portalKey);
  }
}

// ---------------------------------------------------------------------------
// Backwards-compat: default export used by global Providers (fallback config)
// ---------------------------------------------------------------------------

/**
 * Minimal SWR config without a fetcher — used by the root Providers.
 * Portal-specific layouts wrap their children with their own SWRConfig
 * that provides the correct fetcher + refresh logic.
 *
 * @deprecated Import portal-specific configs instead.
 */
export const swrConfig: SWRConfiguration = {
  ...SHARED_SWR_OPTIONS,
};
