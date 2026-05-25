'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { User, Shield, Bell } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RouteTransitionLayout,
  usePendingHref,
} from '@/components/shared/route-transition-layout';

/* -------------------------------------------------------------------------- */
/*  Navigation items                                                          */
/* -------------------------------------------------------------------------- */

const SETTINGS_TABS = [
  { href: '/settings', label: 'Profile', icon: User },
  { href: '/settings/security', label: 'Security', icon: Shield },
  { href: '/settings/notifications', label: 'Notifications', icon: Bell },
] as const;

/* -------------------------------------------------------------------------- */
/*  Layout                                                                    */
/* -------------------------------------------------------------------------- */

export default function SettingsLayout({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();
  const pendingHref = usePendingHref();
  // Use the pending destination for active-state when a click is in
  // flight, so the tab highlight flips the moment the user clicks
  // rather than after the route commits.
  const effective = pendingHref ?? pathname;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-fg)]">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Manage your account, security, and notification preferences.
        </p>
      </div>

      {/* Tab navigation */}
      <nav
        className="flex gap-1 border-b border-[var(--color-border)]"
        role="tablist"
        aria-label="Settings sections"
      >
        {SETTINGS_TABS.map((tab) => {
          const isActive =
            tab.href === '/settings'
              ? effective === '/settings'
              : (effective ?? "").startsWith(tab.href);

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

      {/* Tab content, the outer customer layout yields its
          full-page skeleton when the navigation stays inside the
          settings area (see `isSettingsNavigation`), so we take
          over here and swap only the content region. The header +
          tab strip above stay mounted, giving a Stripe/Linear-style
          instant feedback on tab clicks. */}
      <div>
        <RouteTransitionLayout fallback={<SettingsContentSkeleton />}>
          {children}
        </RouteTransitionLayout>
      </div>
    </div>
  );
}

/**
 * Lightweight placeholder shown while the next settings sub-page
 * fetches. Two card-shaped blocks fit Profile / Security /
 * Notifications equally well without looking page-specific.
 */
function SettingsContentSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading settings">
      <Skeleton className="h-40 w-full rounded-lg" />
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}
