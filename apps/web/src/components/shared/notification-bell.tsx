'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Check, CheckCheck, Inbox } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useNotifications, useUnreadCount, getNotificationBasePath } from '@/hooks/use-notifications';
import type { NotificationItem, NotificationPortal } from '@/hooks/use-notifications';

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${String(days)}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${String(months)}mo ago`;

  const years = Math.floor(months / 12);
  return `${String(years)}y ago`;
}

// ---------------------------------------------------------------------------
// Badge display
// ---------------------------------------------------------------------------

function formatBadgeCount(count: number): string {
  if (count > 99) return '99+';
  return String(count);
}

// ---------------------------------------------------------------------------
// Skeleton loading items
// ---------------------------------------------------------------------------

function NotificationSkeleton() {
  return (
    <div className="flex gap-3 px-3 py-3">
      <Skeleton className="mt-1 h-2 w-2 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-2.5 w-16" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single notification row
// ---------------------------------------------------------------------------

interface NotificationRowProps {
  readonly notification: NotificationItem;
  readonly onMarkRead: (id: string) => void;
  readonly onNavigate: (link: string) => void;
}

function NotificationRow({ notification, onMarkRead, onNavigate }: NotificationRowProps) {
  const isUnread = notification.readAt === null;

  const handleClick = () => {
    if (isUnread) {
      onMarkRead(notification.id);
    }
    if (notification.link !== null) {
      onNavigate(notification.link);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={`${isUnread ? 'Unread: ' : ''}${notification.title}`}
      className={cn(
        'flex cursor-pointer gap-3 rounded-[var(--radius-sm)] px-3 py-3 transition-colors duration-150',
        isUnread
          ? 'bg-[var(--color-accent)]/5 hover:bg-[var(--color-accent)]/10'
          : 'hover:bg-[var(--color-surface-hover)]',
      )}
    >
      {/* Unread indicator dot */}
      <div className="mt-1.5 flex shrink-0 items-start">
        <span
          className={cn(
            'block h-2 w-2 rounded-full',
            isUnread ? 'bg-[var(--color-accent)]' : 'bg-transparent',
          )}
          aria-hidden="true"
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-sm',
            isUnread
              ? 'font-semibold text-[var(--color-fg)]'
              : 'font-medium text-[var(--color-fg)]',
          )}
        >
          {notification.title}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs text-[var(--color-muted)]">
          {notification.body}
        </p>
        <p className="mt-1 text-[10px] text-[var(--color-muted)]">
          {relativeTime(notification.createdAt)}
        </p>
      </div>

      {/* Mark as read button (only for unread) */}
      {isUnread && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMarkRead(notification.id);
          }}
          className="mt-1 shrink-0 flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
          aria-label={`Mark "${notification.title}" as read`}
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Inbox
        className="mb-3 h-10 w-10 text-[var(--color-muted)]"
        aria-hidden="true"
      />
      <p className="text-sm font-medium text-[var(--color-fg)]">
        No notifications yet
      </p>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        We&apos;ll notify you when something important happens.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NotificationBell
// ---------------------------------------------------------------------------

interface NotificationBellProps {
  /** Which portal this bell belongs to, determines the API endpoints used. */
  readonly portal?: NotificationPortal;
}

/**
 * Bell icon with unread count badge. Click opens a Popover dropdown panel
 * showing the most recent notifications with read/unread state, mark-read
 * actions, and navigation on click.
 *
 * Accepts a `portal` prop to select the correct notification API endpoints
 * for the current layout (customer, dashboard, admin).
 */
export function NotificationBell({ portal = 'customer' }: NotificationBellProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const basePath = getNotificationBasePath(portal);

  const {
    notifications,
    isLoading,
    mutate: mutateNotifications,
  } = useNotifications({ limit: 20, portal });

  const {
    count: unreadCountValue,
    mutate: mutateUnread,
  } = useUnreadCount({ portal });

  // Mark single notification as read, optimistic: flip the row to
  // `readAt = now` and decrement the unread count *before* the POST
  // so the bell badge reacts on the very same frame as the click.
  // On failure we revalidate both caches so the server is the source
  // of truth again and surface a toast. The notifications hook uses
  // SWR-Infinite so the cache shape is `NotificationsPage[]`, we
  // map across every page rather than a flat list.
  const handleMarkRead = React.useCallback(
    async (notificationId: string) => {
      const nowIso = new Date().toISOString();

      await Promise.all([
        mutateNotifications(
          (pages) =>
            pages?.map((page) => ({
              ...page,
              notifications: page.notifications.map((n) =>
                n.id === notificationId && n.readAt === null
                  ? { ...n, readAt: nowIso }
                  : n,
              ),
            })),
          { revalidate: false },
        ),
        mutateUnread(
          (current) => ({ count: Math.max(0, (current?.count ?? 0) - 1) }),
          { revalidate: false },
        ),
      ]);

      try {
        const res = await fetch(`${basePath}/${notificationId}/read`, {
          method: 'PATCH',
          credentials: 'include',
        });
        if (!res.ok) {
          throw new Error('Failed to mark notification as read');
        }
        // Confirm against server truth, cheap, and keeps edge cases
        // (clock skew, concurrent tab action) from drifting.
        await Promise.all([mutateNotifications(), mutateUnread()]);
      } catch {
        // Roll back by refetching; then tell the user.
        await Promise.all([mutateNotifications(), mutateUnread()]);
        toast.error('Failed to mark notification as read');
      }
    },
    [basePath, mutateNotifications, mutateUnread],
  );

  // Mark all as read, same pattern: zero the badge, flip every row
  // to `readAt = now`, then POST in the background. Failure path
  // revalidates (pulling the real state back) and shows a toast.
  const handleMarkAllRead = React.useCallback(async () => {
    const nowIso = new Date().toISOString();

    await Promise.all([
      mutateNotifications(
        (pages) =>
          pages?.map((page) => ({
            ...page,
            notifications: page.notifications.map((n) =>
              n.readAt === null ? { ...n, readAt: nowIso } : n,
            ),
          })),
        { revalidate: false },
      ),
      mutateUnread({ count: 0 }, { revalidate: false }),
    ]);

    try {
      const res = await fetch(`${basePath}/read-all`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error('Failed to mark all as read');
      }
      await Promise.all([mutateNotifications(), mutateUnread()]);
    } catch {
      await Promise.all([mutateNotifications(), mutateUnread()]);
      toast.error('Failed to mark all notifications as read');
    }
  }, [basePath, mutateNotifications, mutateUnread]);

  // Navigate to notification link
  const handleNavigate = React.useCallback(
    (link: string) => {
      setOpen(false);
      router.push(link);
    },
    [router],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            unreadCountValue > 0
              ? `${String(unreadCountValue)} unread notifications`
              : 'No new notifications'
          }
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {unreadCountValue > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[10px] font-bold text-white"
              aria-hidden="true"
            >
              {formatBadgeCount(unreadCountValue)}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 p-0 sm:w-96"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">
            Notifications
          </h3>
          {unreadCountValue > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/10"
              aria-label="Mark all notifications as read"
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Mark all read
            </button>
          )}
        </div>

        {/* Content */}
        <ScrollArea className="max-h-[400px]">
          <div className="py-1">
            {isLoading && (
              <>
                <NotificationSkeleton />
                <NotificationSkeleton />
                <NotificationSkeleton />
              </>
            )}

            {!isLoading && notifications.length === 0 && <EmptyState />}

            {!isLoading &&
              notifications.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onMarkRead={handleMarkRead}
                  onNavigate={handleNavigate}
                />
              ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
