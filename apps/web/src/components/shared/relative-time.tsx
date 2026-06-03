'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface RelativeTimeProps {
  date: Date | string | number;
  className?: string;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;

function formatRelative(date: Date): string {
  const now = Date.now();
  const diffSeconds = Math.floor((now - date.getTime()) / 1000);

  if (diffSeconds < 30) return 'Just now';
  if (diffSeconds < MINUTE) return `${diffSeconds}s ago`;
  if (diffSeconds < HOUR) return `${Math.floor(diffSeconds / MINUTE)}m ago`;
  if (diffSeconds < DAY) return `${Math.floor(diffSeconds / HOUR)}h ago`;
  if (diffSeconds < WEEK) return `${Math.floor(diffSeconds / DAY)}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

function formatAbsolute(date: Date): string {
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * Relative time display ("2m ago") with auto-update.
 * Tooltip shows absolute date/time.
 * Updates every 60s for recent (<1h), every 5min for older.
 */
export function RelativeTime({ date, className }: RelativeTimeProps) {
  const dateObj = React.useMemo(() => new Date(date), [date]);
  const [text, setText] = React.useState(() => formatRelative(dateObj));

  React.useEffect(() => {
    const update = () => setText(formatRelative(dateObj));
    update();

    const diffMs = Date.now() - dateObj.getTime();
    const intervalMs = diffMs < 3600000 ? 60000 : 300000; // 1min or 5min
    const timer = setInterval(update, intervalMs);
    return () => clearInterval(timer);
  }, [dateObj]);

  return (
    <time
      dateTime={dateObj.toISOString()}
      title={formatAbsolute(dateObj)}
      className={cn('text-[var(--color-muted)]', className)}
    >
      {text}
    </time>
  );
}
