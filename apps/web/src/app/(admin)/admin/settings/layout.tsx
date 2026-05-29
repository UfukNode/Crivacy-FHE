'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Shield, User } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RouteTransitionLayout,
  usePendingHref,
} from '@/components/shared/route-transition-layout';

/* -------------------------------------------------------------------------- */
/*  Tab navigation                                                             */
/* -------------------------------------------------------------------------- */

const SETTINGS_TABS = [
  { href: '/admin/settings', label: 'Profile', icon: User },
  { href: '/admin/settings/security', label: 'Security', icon: Shield },
] as const;

/**
 * Admin settings layout. Mirrors the customer + firm patterns: shared
 * header + horizontal tab strip stays mounted across sub-route
 * navigations, only the content area swaps (via the inner
 * {@link RouteTransitionLayout}). The outer admin layout yields its
 * full-page skeleton when a click lands inside `/admin/settings`, so
 * the tab bar does not flash off during intra-settings navigation.
 */
export default function AdminSettingsLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const pathname = usePathname();
  const pendingHref = usePendingHref();
  const effective = pendingHref ?? pathname;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-fg)]">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Manage your admin profile and security settings.
        </p>
      </div>

      <nav
        className="flex gap-1 border-b border-[var(--color-border)]"
        role="tablist"
        aria-label="Settings sections"
      >
        {SETTINGS_TABS.map((tab) => {
          const isActive =
            tab.href === '/admin/settings'
              ? effective === '/admin/settings'
              : (effective ?? '').startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              role="tab"
              aria-selected={isActive}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'border-transparent text-[var(--color-muted)] hover:border-[var(--color-border)] hover:text-[var(--color-fg)]',
              )}
            >
              <tab.icon className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{tab.label}</span>
            </Link>
          );
        })}
      </nav>

      <div>
        <RouteTransitionLayout fallback={<SettingsContentSkeleton />}>
          {children}
        </RouteTransitionLayout>
      </div>
    </div>
  );
}

function SettingsContentSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading settings">
      <Skeleton className="h-40 w-full rounded-lg" />
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}
