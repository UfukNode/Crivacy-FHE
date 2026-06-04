'use client';

import * as React from 'react';
import Link from 'next/link';
import { LogOut, Settings, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/shared/user-avatar';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserMenuUser {
  readonly id: string;
  readonly email: string | null;
  readonly displayName?: string | null;
  readonly avatarUrl?: string | null;
  readonly role: string;
}

export type PortalType = 'customer' | 'dashboard' | 'admin';

export interface UserMenuProps {
  readonly user: UserMenuUser;
  readonly portalType: PortalType;
  readonly onSignOut: () => void;
  readonly className?: string;
}

// ---------------------------------------------------------------------------
// Settings link mapping per portal
// ---------------------------------------------------------------------------

// `null` means the portal has no dedicated settings / security page and
// the link should be omitted from the dropdown entirely. Admin auth flows
// run through the main admin sections (Users, Roles, System) so there's
// no per-user settings surface to link to.
const SETTINGS_HREF: Record<PortalType, string | null> = {
  customer: '/settings',
  dashboard: '/dashboard/settings',
  admin: null,
};

const SECURITY_HREF: Record<PortalType, string | null> = {
  customer: '/settings/security',
  dashboard: '/dashboard/settings/security',
  admin: null,
};

// ---------------------------------------------------------------------------
// Role display badge variant
// ---------------------------------------------------------------------------

function roleBadgeVariant(role: string): 'default' | 'secondary' | 'destructive' {
  if (role === 'admin' || role === 'super_admin') return 'destructive';
  if (role.startsWith('firm')) return 'default';
  return 'secondary';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * User dropdown menu with contextual links per portal type.
 *
 * Sections:
 * 1. User info (email, role badge)
 * 2. Settings + Security links
 * 3. Theme toggle row
 * 4. Sign out
 */
export function UserMenu({ user, portalType, onSignOut, className }: UserMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn('relative h-8 w-8 rounded-full p-0', className)}
          aria-label="Open user menu"
        >
          <UserAvatar user={user} size="sm" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-64" align="end" sideOffset={8}>
        {/* ---- User info ---- */}
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-1.5">
            {user.displayName && (
              <p className="text-sm font-medium leading-none text-[var(--color-fg)]">
                {user.displayName}
              </p>
            )}
            <p className="truncate text-xs text-[var(--color-muted)]">{user.email ?? 'Wallet User'}</p>
            {user.role !== 'customer' && (
              <Badge variant={roleBadgeVariant(user.role)} className="w-fit text-[10px]">
                {user.role.replace(/_/g, ' ')}
              </Badge>
            )}
          </div>
        </DropdownMenuLabel>

        {/* ---- Navigation links, omitted when the portal has no
             dedicated settings surface (e.g. admin). ---- */}
        {(SETTINGS_HREF[portalType] !== null || SECURITY_HREF[portalType] !== null) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {SETTINGS_HREF[portalType] !== null && (
                <DropdownMenuItem asChild>
                  <Link
                    href={SETTINGS_HREF[portalType] as string}
                    className="flex items-center gap-2"
                  >
                    <Settings className="h-4 w-4" aria-hidden="true" />
                    Settings
                  </Link>
                </DropdownMenuItem>
              )}
              {SECURITY_HREF[portalType] !== null && (
                <DropdownMenuItem asChild>
                  <Link
                    href={SECURITY_HREF[portalType] as string}
                    className="flex items-center gap-2"
                  >
                    <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                    Security
                  </Link>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </>
        )}

        <DropdownMenuSeparator />

        {/* ---- Theme toggle ---- */}
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-sm text-[var(--color-muted)]">Theme</span>
          <ThemeToggle />
        </div>

        <DropdownMenuSeparator />

        {/* ---- Sign out ---- */}
        <DropdownMenuItem
          onClick={onSignOut}
          className="text-[var(--color-danger)] focus:bg-[var(--color-danger)]/10 focus:text-[var(--color-danger)]"
        >
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
