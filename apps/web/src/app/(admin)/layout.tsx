'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronRight,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldAlert,
  LayoutDashboard,
  Building2,
  Users,
  ShieldCheck,
  Ticket,
  ScrollText,
  AlertTriangle,
  Server,
  PlusCircle,
} from 'lucide-react';
import useSWR, { SWRConfig } from 'swr';
import { adminSwrConfig, startProactiveRefresh } from '@/lib/swr-config';
import { cn } from '@/lib/utils';
import { SidebarNav } from '@/components/shared/sidebar';
import { UserMenu } from '@/components/shared/user-menu';
import { ADMIN_NAV } from '@/components/shared/nav-config';
import type { NavSection } from '@/components/shared/nav-config';
import { useAdminPermissions } from '@/hooks/use-admin-permissions';
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
import AdminLoading from './admin/loading';
import { CommandPalette } from '@/components/shared/command-palette';
import type { CommandEntry } from '@/components/shared/command-palette';

interface AdminMeResponse {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const STORAGE_KEY = 'crivacy-admin-sidebar-collapsed';

/** Sentinel user for the brief period between SWR fetch and response. */
const PLACEHOLDER_USER = { id: '', email: '', displayName: '', role: 'superadmin' } as const;

/**
 * When navigation stays inside the settings area (Profile ↔ Security)
 * the outer admin layout yields its full-page skeleton to the inner
 * settings layout, which keeps the header + tab strip mounted and
 * only swaps the content region. Same pattern as customer + firm.
 */
function isAdminSettingsPath(path: string): boolean {
  return path === '/admin/settings' || path.startsWith('/admin/settings/');
}

function isAdminSettingsNavigation(pendingHref: string, pathname: string): boolean {
  return isAdminSettingsPath(pendingHref) && isAdminSettingsPath(pathname);
}

/* -------------------------------------------------------------------------- */
/*  Command palette entries                                                   */
/* -------------------------------------------------------------------------- */

const ADMIN_COMMANDS: readonly CommandEntry[] = [
  // Navigation
  { label: 'Overview', href: '/admin', icon: LayoutDashboard, group: 'navigation', keywords: ['home', 'dashboard'] },
  { label: 'Firms', href: '/admin/firms', icon: Building2, group: 'navigation', keywords: ['company', 'organization'] },
  { label: 'Customers', href: '/admin/customers', icon: Users, group: 'navigation', keywords: ['user', 'account'] },
  { label: 'Roles & Permissions', href: '/admin/rbac', icon: ShieldCheck, group: 'navigation', keywords: ['rbac', 'role', 'permission', 'access'] },
  { label: 'Tickets', href: '/admin/tickets', icon: Ticket, group: 'navigation', keywords: ['support', 'help', 'issue'] },
  { label: 'Audit Log', href: '/admin/audit', icon: ScrollText, group: 'navigation', keywords: ['log', 'history', 'activity'] },
  { label: 'Status Page', href: '/admin/status', icon: AlertTriangle, group: 'navigation', keywords: ['uptime', 'incident', 'maintenance'] },
  { label: 'System', href: '/admin/system', icon: Server, group: 'navigation', keywords: ['health', 'config', 'infrastructure'] },
  { label: 'Settings', href: '/admin/settings', icon: ShieldAlert, group: 'navigation', keywords: ['preferences', 'account', 'profile'] },
  { label: 'Security (2FA)', href: '/admin/settings/security', icon: ShieldCheck, group: 'navigation', keywords: ['2fa', 'totp', 'authenticator', 'recovery', 'security', 'password'] },
  // Actions
  { label: 'Create Role', href: '/admin/rbac', icon: PlusCircle, group: 'actions', keywords: ['new', 'role', 'permission'] },
];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const ADMIN_ROLE_LEVEL: Record<string, number> = {
  support: 0,
  admin: 1,
  superadmin: 2,
};

/** Filter nav sections based on the admin user's role. Items with a
 *  `minRole` higher than the user's role are removed. Sections with
 *  no remaining items are dropped entirely. */
function filterNavByRole(sections: readonly NavSection[], userRole: string): readonly NavSection[] {
  const level = ADMIN_ROLE_LEVEL[userRole] ?? 0;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (item.minRole === undefined) return true;
        const required = ADMIN_ROLE_LEVEL[item.minRole] ?? 0;
        return level >= required;
      }),
    }))
    .filter((section) => section.items.length > 0);
}

function getInitialCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

/**
 * Build breadcrumb segments from the current pathname.
 * e.g. "/admin/firms/detail" -> ["Admin", "Firms", "Detail"]
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
/*  Admin badge                                                               */
/* -------------------------------------------------------------------------- */

interface AdminBadgeProps {
  readonly collapsed: boolean;
}

function AdminBadge({ collapsed }: AdminBadgeProps) {
  if (collapsed) {
    return (
      <div className="flex justify-center">
        <ShieldAlert className="h-4 w-4 text-[var(--color-accent)]" aria-label="Admin Panel" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-accent)]/10 px-3 py-1.5">
      <ShieldAlert className="h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />
      <span className="text-xs font-medium text-[var(--color-accent)]">Admin Panel</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Layout                                                                    */
/* -------------------------------------------------------------------------- */

export default function AdminLayout({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/admin/login';

  React.useEffect(() => {
    if (isLoginPage) return;
    startProactiveRefresh('admin', '/api/internal/admin/auth/refresh');
  }, [isLoginPage]);

  // Login page renders without the admin shell, no SWR fetcher, no sidebar,
  // no notification bell, no API calls that would trigger a 401 → redirect loop.
  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <SWRConfig value={adminSwrConfig}>
      <NavigationTransitionProvider>
        <AdminLayoutInner>{children}</AdminLayoutInner>
      </NavigationTransitionProvider>
    </SWRConfig>
  );
}

function AdminLayoutInner({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(getInitialCollapsed);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const { data: me, isLoading: meLoading } = useSWR<AdminMeResponse>('/api/internal/admin/me');

  const user = React.useMemo(() => {
    if (!me) return PLACEHOLDER_USER;
    return { id: me.id, email: me.email, displayName: me.displayName, role: me.role };
  }, [me]);

  // RBAC-based permission filter. `has` is memoised, stable across renders.
  const { has: hasAdminPermission, isLoading: permsLoading } = useAdminPermissions();

  // Direct-URL guard, redirect to /admin when caller hits a page
  // their permission set excludes. Matches the firm dashboard pattern.
  useRouteGuard(ADMIN_NAV, hasAdminPermission, '/admin', {
    ready: !permsLoading,
  });

  const filteredNav = React.useMemo(
    () => filterNavByRole(ADMIN_NAV, user.role),
    [user.role],
  );

  const filteredCommands = React.useMemo(
    () => {
      const level = ADMIN_ROLE_LEVEL[user.role] ?? 0;
      const visibleHrefs = new Set(
        filteredNav.flatMap((s) => s.items.map((i) => i.href)),
      );
      return ADMIN_COMMANDS.filter((cmd) => cmd.href !== undefined && visibleHrefs.has(cmd.href));
    },
    [filteredNav, user.role],
  );

  const handleSignOut = React.useCallback(async () => {
    try {
      await fetch('/api/internal/admin/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Best-effort
    }
    window.location.href = '/admin/login';
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
               clean across the entire app top edge. */}
          <div className="flex h-14 items-center border-b border-[var(--color-border)] px-4">
            <Link
              href="/admin"
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
              sections={filteredNav}
              collapsed={collapsed}
              accentColor="--color-accent"
              hasPermission={hasAdminPermission}
            />
          </nav>

          <Separator />

          {/* Footer: badge + collapse toggle */}
          <div className="space-y-1 p-2">
            {/* Admin badge */}
            <AdminBadge collapsed={collapsed} />

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
                href="/admin"
                className="text-[var(--color-fg)]"
                onClick={() => setMobileOpen(false)}
              >
                <CrivacyLogo className="h-6" />
              </Link>
            </div>

            {/* Mobile nav */}
            <nav className="flex-1 overflow-y-auto py-2">
              <SidebarNav
                sections={filteredNav}
                accentColor="--color-accent"
                hasPermission={hasAdminPermission}
              />
            </nav>

            <Separator />

            {/* Mobile footer */}
            <div className="space-y-1 p-2">
              <AdminBadge collapsed={false} />
            </div>
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
              <NotificationBell portal="admin" />
              <ThemeToggle />
              {meLoading ? (
                <Skeleton className="h-8 w-8 rounded-full" />
              ) : (
                <UserMenu user={user} portalType="admin" onSignOut={handleSignOut} />
              )}
            </div>
          </header>

          {/* Page content, RouteTransitionLayout swaps the children
              for the loading skeleton on pathname change so nav clicks
              produce instant visual feedback even though our pages are
              client components (which otherwise bypass the Next.js
              Suspense + loading.tsx path). */}
          <main id="main-content" className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
              <RouteTransitionLayout
                fallback={<AdminLoading />}
                skipFor={isAdminSettingsNavigation}
              >
                {children}
              </RouteTransitionLayout>
            </div>
          </main>
        </div>
      </div>

      <CommandPalette commands={filteredCommands} />
    </TooltipProvider>
  );
}
