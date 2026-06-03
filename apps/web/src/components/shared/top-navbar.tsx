'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, Bell } from 'lucide-react';
import { usePendingHref } from './route-transition-layout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { UserMenu } from '@/components/shared/user-menu';
import type { NavItem } from './nav-config';
import type { UserMenuUser } from './user-menu';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopNavbarProps {
  readonly user: UserMenuUser;
  readonly navItems: readonly NavItem[];
  readonly onSignOut: () => void;
  readonly logo?: React.ReactNode;
  readonly notificationCount?: number;
  /** Optional React node to render instead of the default bell button. */
  readonly notificationSlot?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Active-state helper
// ---------------------------------------------------------------------------

function isActive(pathname: string, item: NavItem): boolean {
  if (item.end) {
    return pathname === item.href;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

// ---------------------------------------------------------------------------
// Desktop nav link
// ---------------------------------------------------------------------------

function NavLink({
  item,
  active,
}: {
  readonly item: NavItem;
  readonly active: boolean;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium transition-colors duration-[var(--duration-base)]',
        active
          ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
          : 'text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]',
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      <span>{item.label}</span>
      {item.badge && (
        <Badge
          variant={item.badge === 'new' ? 'default' : 'secondary'}
          className="text-[10px] px-1.5 py-0"
        >
          {item.badge}
        </Badge>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Mobile nav link (inside Sheet)
// ---------------------------------------------------------------------------

function MobileNavLink({
  item,
  active,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly active: boolean;
  readonly onNavigate: () => void;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(
        'flex min-h-11 items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-sm font-medium transition-colors duration-[var(--duration-base)]',
        active
          ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
          : 'text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]',
      )}
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
      <span>{item.label}</span>
      {item.badge && (
        <Badge
          variant={item.badge === 'new' ? 'default' : 'secondary'}
          className="ml-auto text-[10px] px-1.5 py-0"
        >
          {item.badge}
        </Badge>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Responsive top navbar for the customer portal.
 *
 * Desktop (>= 768px): horizontal nav items in center, logo left, user menu right.
 * Mobile (< 768px):  hamburger opens a Sheet from the left with vertical nav items.
 * The mobile sheet auto-closes on navigation via pathname change detection.
 */
export function TopNavbar({
  user,
  navItems,
  onSignOut,
  logo,
  notificationCount = 0,
  notificationSlot,
}: TopNavbarProps) {
  const pathname = usePathname();
  const pendingHref = usePendingHref();
  // Instant active-state during a click-to-commit window, see
  // `NavigationTransitionProvider` for the mechanics.
  const effectivePathname = pendingHref ?? pathname ?? '';
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Close mobile sheet when pathname changes (user navigated)
  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const closeMobileSheet = React.useCallback(() => {
    setMobileOpen(false);
  }, []);

  return (
    <header
      className="sticky top-0 z-40 flex h-14 items-center border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 px-4 sm:px-6 lg:px-8 backdrop-blur-sm supports-[backdrop-filter]:bg-[var(--color-bg)]/80 safe-top"
      role="banner"
    >
      {/* ---- Mobile hamburger ---- */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2 mr-2 md:hidden"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </Button>
        </SheetTrigger>

        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="border-b border-[var(--color-border)] px-4 py-3">
            <SheetTitle className="text-left">{logo ?? 'Crivacy'}</SheetTitle>
          </SheetHeader>

          <nav className="flex flex-col gap-1 p-3" aria-label="Mobile navigation">
            {navItems.map((item) => (
              <MobileNavLink
                key={item.href}
                item={item}
                active={isActive(effectivePathname, item)}
                onNavigate={closeMobileSheet}
              />
            ))}
          </nav>

          <Separator />

          <div className="p-3">
            <div className="flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2">
              <span className="truncate text-sm text-[var(--color-muted)]">{user.email ?? user.displayName ?? 'Wallet User'}</span>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* ---- Logo ---- */}
      <div className="flex items-center gap-2">
        <Link href="/" aria-label="Go to home page" className="flex items-center">
          {logo ?? (
            <span className="text-lg font-bold tracking-tight text-[var(--color-fg)]">
              Crivacy
            </span>
          )}
        </Link>
      </div>

      {/* ---- Desktop nav ---- */}
      <nav
        className="mx-6 hidden flex-1 items-center justify-center gap-1 md:flex"
        aria-label="Main navigation"
      >
        {navItems.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(effectivePathname, item)} />
        ))}
      </nav>

      {/* ---- Spacer on mobile ---- */}
      <div className="flex-1 md:hidden" />

      {/* ---- Right side: notifications + user menu ---- */}
      <div className="flex items-center gap-2">
        {notificationSlot !== undefined ? (
          notificationSlot
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={
              notificationCount > 0
                ? `${String(notificationCount)} unread notifications`
                : 'No new notifications'
            }
          >
            <Bell className="h-4 w-4" aria-hidden="true" />
            {notificationCount > 0 && (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-danger)] text-[10px] font-bold text-white"
                aria-hidden="true"
              >
                {notificationCount > 99 ? '99+' : notificationCount}
              </span>
            )}
          </Button>
        )}

        <ThemeToggle />

        <UserMenu user={user} portalType="customer" onSignOut={onSignOut} />
      </div>
    </header>
  );
}
