'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  LayoutDashboard,
  ShieldCheck,
  CreditCard,
  Ticket,
  Settings,
  KeyRound,
  PlusCircle,
  Lock,
} from 'lucide-react';
import useSWR, { SWRConfig } from 'swr';
import { customerSwrConfig, startProactiveRefresh } from '@/lib/swr-config';
import { TopNavbar } from '@/components/shared/top-navbar';
import { CrivacyLogo } from '@/components/shared/crivacy-logo';
import { CUSTOMER_NAV } from '@/components/shared/nav-config';
import { NotificationBell } from '@/components/shared/notification-bell';
import {
  NavigationTransitionProvider,
  RouteTransitionLayout,
} from '@/components/shared/route-transition-layout';
import CustomerLoading from './loading';
import { CommandPalette } from '@/components/shared/command-palette';
import type { CommandEntry } from '@/components/shared/command-palette';

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

interface CustomerMeResponse {
  readonly id: string;
  readonly email: string | null;
  readonly displayName?: string | null;
  readonly avatarUrl?: string | null;
  readonly role: string;
  readonly kycLevel: string;
  readonly kycScore: number;
  readonly status: string;
  readonly hasPassword?: boolean;
  readonly hasEmail?: boolean;
  readonly linkedAccounts?: readonly { provider: string; email: string | null; displayName: string | null }[];
}

/* -------------------------------------------------------------------------- */
/*  Command palette entries                                                   */
/* -------------------------------------------------------------------------- */

const CUSTOMER_COMMANDS: readonly CommandEntry[] = [
  // Navigation
  { label: 'Dashboard', href: '/', icon: LayoutDashboard, group: 'navigation', keywords: ['home', 'overview'] },
  { label: 'Verification', href: '/kyc', icon: ShieldCheck, group: 'navigation', keywords: ['kyc', 'identity', 'verify'] },
  { label: 'Credential', href: '/credential', icon: CreditCard, group: 'navigation', keywords: ['card', 'certificate'] },
  { label: 'Support', href: '/tickets', icon: Ticket, group: 'navigation', keywords: ['help', 'ticket', 'contact'] },
  { label: 'Settings', href: '/settings', icon: Settings, group: 'navigation', keywords: ['preferences', 'account'] },
  // Actions
  { label: 'Start KYC', href: '/kyc', icon: KeyRound, group: 'actions', keywords: ['verify', 'identity'] },
  { label: 'Create ticket', href: '/tickets/new', icon: PlusCircle, group: 'actions', keywords: ['support', 'help', 'issue'] },
  { label: 'Change password', href: '/settings/security', icon: Lock, group: 'actions', keywords: ['security', 'password'] },
];

/* -------------------------------------------------------------------------- */
/*  Fallback user (shown while loading)                                       */
/* -------------------------------------------------------------------------- */

const LOADING_USER = {
  id: '',
  email: null as string | null,
  role: 'customer',
} as const;

/**
 * When navigation stays inside the settings area (Profile ↔ Security
 * ↔ Notifications) the outer layout yields its full-page skeleton to
 * the inner settings layout, which keeps the header + tab strip
 * mounted and only swaps the content area. Security-wise this is
 * pure UX, access is still gated per-route by each sub-page's own
 * loader.
 */
function isSettingsPath(path: string): boolean {
  return path === '/settings' || path.startsWith('/settings/');
}

function isSettingsNavigation(pendingHref: string, pathname: string): boolean {
  return isSettingsPath(pendingHref) && isSettingsPath(pathname);
}

/* -------------------------------------------------------------------------- */
/*  Layout                                                                    */
/* -------------------------------------------------------------------------- */

export default function CustomerLayout({ children }: { readonly children: React.ReactNode }) {
  React.useEffect(() => {
    startProactiveRefresh('customer', '/api/customer/auth/refresh');
  }, []);

  return (
    <SWRConfig value={customerSwrConfig}>
      <NavigationTransitionProvider>
        <CustomerLayoutInner>{children}</CustomerLayoutInner>
      </NavigationTransitionProvider>
    </SWRConfig>
  );
}

function CustomerLayoutInner({ children }: { readonly children: React.ReactNode }) {
  const { data: me } = useSWR<CustomerMeResponse>('/api/customer/me');

  const user = React.useMemo(() => {
    if (!me) return LOADING_USER;
    return {
      id: me.id,
      email: me.email ?? null,
      displayName: me.displayName ?? null,
      avatarUrl: me.avatarUrl ?? null,
      role: me.role,
    };
  }, [me]);

  const handleSignOut = React.useCallback(async () => {
    try {
      await fetch('/api/customer/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Best-effort, cookie clearing happens server-side
    }
    window.location.href = '/login';
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg)]">
      <TopNavbar
        user={user}
        navItems={CUSTOMER_NAV}
        onSignOut={handleSignOut}
        logo={<CrivacyLogo className="h-7" />}
        notificationSlot={<NotificationBell portal="customer" />}
      />

      <main id="main-content" className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <RouteTransitionLayout
          fallback={<CustomerLoading />}
          skipFor={isSettingsNavigation}
        >
          {children}
        </RouteTransitionLayout>
      </main>

      <footer className="border-t border-[var(--color-border)]">
        <div className="mx-auto flex max-w-4xl gap-1 px-4 py-4 text-xs text-[var(--color-muted)] sm:px-6 lg:px-8">
          <Link href="/terms" className="transition-colors hover:text-[var(--color-accent)]">
            Terms
          </Link>
          <span aria-hidden="true">&middot;</span>
          <Link href="/privacy" className="transition-colors hover:text-[var(--color-accent)]">
            Privacy
          </Link>
        </div>
      </footer>

      <CommandPalette commands={CUSTOMER_COMMANDS} />
    </div>
  );
}
