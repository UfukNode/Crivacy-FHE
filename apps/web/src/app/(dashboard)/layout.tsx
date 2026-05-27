'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronRight,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  LayoutDashboard,
  KeyRound,
  Webhook,
  BarChart3,
  ScrollText,
  Settings,
  PlusCircle,
  Ticket,
  Shield,
  AppWindow,
} from 'lucide-react';
import useSWR, { SWRConfig } from 'swr';
import { dashboardSwrConfig, startProactiveRefresh } from '@/lib/swr-config';
import { cn } from '@/lib/utils';
import { SidebarNav } from '@/components/shared/sidebar';
import { UserMenu } from '@/components/shared/user-menu';
import { DASHBOARD_NAV } from '@/components/shared/nav-config';
import { useFirmPermissions } from '@/hooks/use-firm-permissions';
import { useRouteGuard } from '@/hooks/use-route-guard';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { CrivacyLogo } from '@/components/shared/crivacy-logo';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { NotificationBell } from '@/components/shared/notification-bell';
import {
  NavigationTransitionProvider,
  RouteTransitionLayout,
} from '@/components/shared/route-transition-layout';
import DashboardLoading from './dashboard/loading';
import { CommandPalette } from '@/components/shared/command-palette';
import type { CommandEntry } from '@/components/shared/command-palette';

interface DashboardMeResponse {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly firmId: string;
  readonly firmName: string;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const STORAGE_KEY = 'crivacy-sidebar-collapsed';

/** Sentinel user for the brief period between SWR fetch and response. */
const PLACEHOLDER_USER = { id: '', email: '', role: 'member' } as const;

/**
 * When navigation stays inside the settings area (Profile ↔ Security
 * ↔ Team) the outer layout yields its full-page skeleton to the
 * inner settings layout, which keeps the header + tab strip mounted
 * and only swaps the content area. Security-wise this is pure UX —
 * access is still gated per-route by each sub-page's own loader.
 */
function isSettingsPath(path: string): boolean {
  return path === '/dashboard/settings' || path.startsWith('/dashboard/settings/');
}

function isSettingsNavigation(pendingHref: string, pathname: string): boolean {
  return isSettingsPath(pendingHref) && isSettingsPath(pathname);
}

/* -------------------------------------------------------------------------- */
/*  Command palette entries                                                   */
/* -------------------------------------------------------------------------- */

const DASHBOARD_COMMANDS: readonly CommandEntry[] = [
  // Navigation
  { label: 'Overview', href: '/dashboard', icon: LayoutDashboard, group: 'navigation', keywords: ['home', 'dashboard'] },
  { label: 'Playground', href: '/dashboard/playground', icon: Shield, group: 'navigation', keywords: ['test', 'sandbox'] },
  { label: 'OAuth Clients', href: '/dashboard/oauth-clients', icon: AppWindow, group: 'navigation', keywords: ['oauth', 'app', 'client', 'application', 'sso', 'connect'] },
  { label: 'API Keys', href: '/dashboard/api-keys', icon: KeyRound, group: 'navigation', keywords: ['key', 'token', 'integration'] },
  { label: 'Webhooks', href: '/dashboard/webhooks', icon: Webhook, group: 'navigation', keywords: ['hook', 'event', 'notification'] },
  { label: 'Usage', href: '/dashboard/usage', icon: BarChart3, group: 'navigation', keywords: ['metrics', 'analytics', 'billing'] },
  { label: 'Audit Log', href: '/dashboard/audit', icon: ScrollText, group: 'navigation', keywords: ['log', 'history', 'activity'] },
  { label: 'Tickets', href: '/dashboard/tickets', icon: Ticket, group: 'navigation', keywords: ['support', 'help'] },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings, group: 'navigation', keywords: ['preferences', 'account', 'config'] },
  { label: 'Security (2FA)', href: '/dashboard/settings/security', icon: Shield, group: 'navigation', keywords: ['2fa', 'totp', 'authenticator', 'recovery', 'security', 'password'] },
  // Actions
  { label: 'Register OAuth Client', href: '/dashboard/oauth-clients', icon: PlusCircle, group: 'actions', keywords: ['create', 'new', 'oauth', 'app', 'application'] },
  { label: 'Generate API Key', href: '/dashboard/api-keys', icon: PlusCircle, group: 'actions', keywords: ['create', 'new', 'key'] },
  { label: 'Configure Webhook', href: '/dashboard/webhooks', icon: Webhook, group: 'actions', keywords: ['create', 'new', 'hook'] },
];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function getInitialCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

/**
 * Build breadcrumb segments from the current pathname.
 * e.g. "/dashboard/api-keys" -> ["Dashboard", "Api Keys"]
 */
function buildBreadcrumbs(pathname: string): readonly { readonly label: string; readonly href: string }[] {
  const segments = pathname.split('/').filter(Boolean);
  return segments.map((segment, index) => ({
    label: segment
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' '),
    href: '/' + segments.slice(0, index + 1).join('/'),
  }));
}

/* -------------------------------------------------------------------------- */
/*  Layout                                                                    */
/* -------------------------------------------------------------------------- */

export default function DashboardLayout({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();
  // Public (unauthenticated) entry points, login, accept-invite and
  // the password-reset pair all render without the authenticated
  // dashboard shell. Sharing the bypass prevents the shell from
  // firing SWR `/me` fetches that would 401 and trap the page in a
  // redirect loop.
  const isPublicEntry =
    pathname === '/dashboard/login' ||
    pathname === '/dashboard/accept-invite' ||
    pathname === '/dashboard/forgot-password' ||
    pathname === '/dashboard/reset-password';

  React.useEffect(() => {
    if (isPublicEntry) return;
    startProactiveRefresh('dashboard', '/api/internal/auth/refresh');
  }, [isPublicEntry]);

  if (isPublicEntry) {
    return <>{children}</>;
  }

  return (
    <SWRConfig value={dashboardSwrConfig}>
      <NavigationTransitionProvider>
        <DashboardLayoutInner>{children}</DashboardLayoutInner>
      </NavigationTransitionProvider>
    </SWRConfig>
  );
}

function DashboardLayoutInner({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(getInitialCollapsed);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const { data: me, isLoading: meLoading } = useSWR<DashboardMeResponse>('/api/internal/me');
  // Permission set drives nav visibility. `has` stays referentially
  // stable across renders (memoised in the hook) so passing it down
  // does not trigger SidebarNav re-renders on unrelated state changes.
  const { has: hasFirmPermission, isLoading: permsLoading } = useFirmPermissions();

  // Direct-link guard, if the user navigates to a URL they do not
  // have permission for, bounce them back to /dashboard with a toast.
  // Suppressed until the permission set has loaded so the first frame
  // after login doesn't redirect before `has` can return a real answer.
  useRouteGuard(DASHBOARD_NAV, hasFirmPermission, '/dashboard', {
    ready: !permsLoading,
  });

  const user = React.useMemo(() => {
    if (!me) return PLACEHOLDER_USER;
    return { id: me.id, email: me.email, role: me.role };
  }, [me]);

  const handleSignOut = React.useCallback(async () => {
    try {
      await fetch('/api/internal/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Best-effort
    }
    window.location.href = '/dashboard/login';
  }, []);

  /* Persist collapsed state */
  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  /* Close mobile sheet on navigation */
  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const breadcrumbs = buildBreadcrumbs(pathname ?? '');

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex min-h-screen bg-[var(--color-bg)]">
        {/* ---------------------------------------------------------------- */}
        {/*  Desktop sidebar                                                 */}
        {/* ---------------------------------------------------------------- */}
        <aside
          className={cn(
            'hidden flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] transition-[width] duration-200 md:flex',
            collapsed ? 'w-16' : 'w-60',
          )}
        >
          {/* Logo, h-14 + border-b match top-header so the line continues
               clean across the entire app top edge. Replaces the prior
               <Separator/> approach which sat 1px below the header's
               border-b and rendered as a visible double-line. */}
          <div className="flex h-14 items-center border-b border-[var(--color-border)] px-4">
            <Link
              href="/dashboard"
              className={cn(
                'flex items-center text-[var(--color-fg)] transition-opacity',
                collapsed && 'justify-center',
              )}
            >
              <CrivacyLogo iconOnly={collapsed} className={collapsed ? 'h-7' : 'h-6'} />
            </Link>
          </div>

          {/* Navigation */}
          <nav className="flex-1 overflow-y-auto py-2">
            <SidebarNav
              sections={DASHBOARD_NAV}
              collapsed={collapsed}
              hasPermission={hasFirmPermission}
            />
          </nav>

          <Separator />

          {/* Footer: collapse toggle */}
          <div className="space-y-1 p-2">
            {/* Collapse toggle */}
            <Button
              variant="ghost"
              size={collapsed ? 'icon' : 'sm'}
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={cn('w-full', !collapsed && 'justify-start gap-2')}
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
              ) : (
                <>
                  <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                  <span>Collapse</span>
                </>
              )}
            </Button>
          </div>
        </aside>

        {/* ---------------------------------------------------------------- */}
        {/*  Mobile sidebar (Sheet)                                          */}
        {/* ---------------------------------------------------------------- */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-72 p-0">
            {/* Mobile logo */}
            <div className="flex h-14 items-center border-b border-[var(--color-border)] px-4">
              <Link
                href="/dashboard"
                className="text-[var(--color-fg)]"
                onClick={() => setMobileOpen(false)}
              >
                <CrivacyLogo className="h-6" />
              </Link>
            </div>

            {/* Mobile nav */}
            <nav className="flex-1 overflow-y-auto py-2">
              <SidebarNav sections={DASHBOARD_NAV} hasPermission={hasFirmPermission} />
            </nav>

            <Separator />

            {/* Mobile footer, empty, UserMenu is in top-right header */}
          </SheetContent>
        </Sheet>

        {/* ---------------------------------------------------------------- */}
        {/*  Main area                                                       */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top bar */}
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
            {/* Mobile hamburger */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </Button>

            {/* Breadcrumbs */}
            <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
              {breadcrumbs.map((crumb, index) => (
                <React.Fragment key={crumb.href}>
                  {index > 0 && (
                    <ChevronRight
                      className="h-3.5 w-3.5 text-[var(--color-muted)]"
                      aria-hidden="true"
                    />
                  )}
                  {index === breadcrumbs.length - 1 ? (
                    <span className="font-medium text-[var(--color-fg)]">{crumb.label}</span>
                  ) : (
                    <Link
                      href={crumb.href}
                      className="text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
                    >
                      {crumb.label}
                    </Link>
                  )}
                </React.Fragment>
              ))}
            </nav>

            {/* Right side */}
            <div className="ml-auto flex items-center gap-1">
              <NotificationBell portal="dashboard" />
              <ThemeToggle />
              {meLoading ? (
                <Skeleton className="h-8 w-8 rounded-full" />
              ) : (
                <UserMenu user={user} portalType="dashboard" onSignOut={handleSignOut} />
              )}
            </div>
          </header>

          {/* Page content, skeleton swap on nav click (see
              RouteTransitionLayout for why this is client-side).
              The playground is a three-panel workbench (endpoints +
              request + response) that doesn't breathe inside the
              default 5xl container, widen it for that route only
              so the rest of the dashboard stays at its calmer
              reading width. */}
          <main id="main-content" className="flex-1 overflow-y-auto">
            <div
              className={cn(
                'mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8',
                pathname === '/dashboard/playground' ? 'max-w-[1600px]' : 'max-w-5xl',
              )}
            >
              <RouteTransitionLayout
                fallback={<DashboardLoading />}
                skipFor={isSettingsNavigation}
              >
                {children}
              </RouteTransitionLayout>
            </div>
          </main>
        </div>
      </div>

      <CommandPalette commands={DASHBOARD_COMMANDS} />
    </TooltipProvider>
  );
}
