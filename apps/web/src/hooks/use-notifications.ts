'use client';

import { useCallback, useRef } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';

import type { NotificationItem } from '@/lib/notification/types';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface NotificationsPage {
  readonly notifications: readonly NotificationItem[];
  readonly nextCursor: string | null;
}

interface UnreadCountResponse {
  readonly count: number;
}

/* -------------------------------------------------------------------------- */
/*  Portal base paths                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Notification API base paths per portal.
 *
 * Customer:  /api/customer/notifications
 * Dashboard: /api/internal/notifications    (firm user)
 * Admin:     /api/internal/admin/notifications
 */
const PORTAL_NOTIFICATION_PATHS = {
  customer: '/api/customer/notifications',
  dashboard: '/api/internal/notifications',
  admin: '/api/internal/admin/notifications',
} as const;

export type NotificationPortal = keyof typeof PORTAL_NOTIFICATION_PATHS;

/** Get the API base path for a given portal's notifications. */
export function getNotificationBasePath(portal: NotificationPortal): string {
  return PORTAL_NOTIFICATION_PATHS[portal];
}

/* -------------------------------------------------------------------------- */
/*  useNotifications — paginated notification list                            */
/* -------------------------------------------------------------------------- */

/**
 * SWR Infinite hook for notifications.
 * Fetches from the portal-specific notification endpoint with cookie-based auth.
 *
 * Supports cursor-based pagination via `loadMore()`.
 */
export function useNotifications(opts?: {
  readonly limit?: number;
  readonly portal?: NotificationPortal;
}) {
  const limit = opts?.limit ?? 20;
  const basePath = PORTAL_NOTIFICATION_PATHS[opts?.portal ?? 'customer'];

  const getKey = useCallback(
    (pageIndex: number, previousPageData: NotificationsPage | null) => {
      // First page
      if (pageIndex === 0) {
        return `${basePath}?limit=${String(limit)}`;
      }

      // No more data
      if (previousPageData === null || previousPageData.nextCursor === null) {
        return null;
      }

      return `${basePath}?limit=${String(limit)}&cursor=${encodeURIComponent(previousPageData.nextCursor)}`;
    },
    [basePath, limit],
  );

  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
    size,
    setSize,
  } = useSWRInfinite<NotificationsPage>(getKey, {
    revalidateFirstPage: true,
    revalidateOnFocus: true,
  });

  // Flatten all pages into a single list
  const notifications: NotificationItem[] = [];
  if (data !== undefined) {
    for (const page of data) {
      for (const n of page.notifications) {
        notifications.push(n);
      }
    }
  }

  // Determine if there are more pages
  const lastPage = data !== undefined && data.length > 0
    ? data[data.length - 1]
    : undefined;
  const hasMore = lastPage !== undefined && lastPage.nextCursor !== null;

  // Prevent multiple concurrent loadMore calls
  const loadingRef = useRef(false);
  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore) return;
    loadingRef.current = true;
    try {
      await setSize(size + 1);
    } finally {
      loadingRef.current = false;
    }
  }, [hasMore, setSize, size]);

  return {
    notifications,
    isLoading,
    isValidating,
    error: error as Error | undefined,
    mutate,
    loadMore,
    hasMore,
  } as const;
}

/* -------------------------------------------------------------------------- */
/*  useUnreadCount — polls every 30s                                          */
/* -------------------------------------------------------------------------- */

/**
 * SWR hook for the unread notification count.
 * Polls every 30 seconds to stay up to date.
 */
export function useUnreadCount(opts?: {
  readonly portal?: NotificationPortal;
}) {
  const basePath = PORTAL_NOTIFICATION_PATHS[opts?.portal ?? 'customer'];

  const { data, error, isLoading, mutate } = useSWR<UnreadCountResponse>(
    `${basePath}/unread-count`,
    {
      refreshInterval: 30000,
      revalidateOnFocus: true,
    },
  );

  return {
    count: data?.count ?? 0,
    isLoading,
    error: error as Error | undefined,
    mutate,
  } as const;
}

export type { NotificationItem, NotificationsPage, UnreadCountResponse };
