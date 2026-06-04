'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { usePendingHref } from './route-transition-layout';
import type { NavItem, NavSection } from './nav-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidebarProps {
  readonly sections: readonly NavSection[];
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
  readonly logo: React.ReactNode;
  readonly footer: React.ReactNode;
  readonly accentColor?: string;
  /**
   * Permission predicate. When provided, nav items carrying a
   * `permission` field are hidden unless `hasPermission(code)` returns
   * true. Items without a `permission` field are always shown.
   *
   * Passed through from the layout, which wires it to the portal's
   * permission hook (`useFirmPermissions` / `useAdminPermissions`).
   * When `undefined`, no filtering is applied, useful for contexts
   * where the full menu should always render (storybook, tests).
   */
  readonly hasPermission?: (code: string) => boolean;
}

export interface SidebarNavProps {
  readonly sections: readonly NavSection[];
  readonly collapsed?: boolean;
  readonly accentColor?: string;
  readonly hasPermission?: (code: string) => boolean;
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
// Single nav item
// ---------------------------------------------------------------------------

function SidebarNavItem({
  item,
  active,
  collapsed,
  accentVar,
}: {
  readonly item: NavItem;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly accentVar: string;
}) {
  const Icon = item.icon;

  const accentStyle = active ? { color: `var(${accentVar})` } : undefined;

  const linkContent = (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      style={accentStyle}
      className={cn(
        'group flex min-h-11 items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium transition-colors duration-[var(--duration-base)]',
        collapsed && 'justify-center px-0',
        active
          ? 'bg-[var(--color-surface-hover)]'
          : 'text-[var(--color-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]',
      )}
    >
      <Icon
        style={accentStyle}
        className={cn(
          'h-4 w-4 shrink-0',
          active ? '' : 'text-[var(--color-muted)] group-hover:text-[var(--color-fg)]',
        )}
        aria-hidden="true"
      />
      {!collapsed && (
        <>
          <span className="truncate">{item.label}</span>
          {item.badge && (
            <Badge
              variant={item.badge === 'new' ? 'default' : 'secondary'}
              className="ml-auto text-[10px] px-1.5 py-0"
            >
              {item.badge}
            </Badge>
          )}
        </>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-2">
          {item.label}
          {item.badge && (
            <Badge
              variant={item.badge === 'new' ? 'default' : 'secondary'}
              className="text-[10px] px-1.5 py-0"
            >
              {item.badge}
            </Badge>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return linkContent;
}

// ---------------------------------------------------------------------------
// SidebarNav, standalone nav section renderer
// ---------------------------------------------------------------------------

/**
 * Renders navigation sections with icons, labels, badges, and active state.
 * Uses `usePathname()` internally for active detection.
 *
 * Must be rendered inside a `TooltipProvider` if `collapsed` is true.
 * Does NOT render its own wrapper element, returns a fragment.
 */
export function SidebarNav({
  sections,
  collapsed = false,
  accentColor = '--color-accent',
  hasPermission,
}: SidebarNavProps) {
  const pathname = usePathname();
  const pendingHref = usePendingHref();
  // When a navigation is in flight, compute active state against the
  // destination path so the clicked item flips to selected on the
  // same frame as the click. Falls back to the committed pathname
  // outside a NavigationTransitionProvider.
  const effectivePathname = pendingHref ?? pathname ?? '';

  // Filter items by permission, then drop any section left empty.
  // When `hasPermission` is undefined (no filtering requested) the
  // full menu passes through unchanged, same behaviour as before
  // RBAC wiring.
  const visibleSections = React.useMemo(() => {
    if (hasPermission === undefined) return sections;
    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) => item.permission === undefined || hasPermission(item.permission),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [sections, hasPermission]);

  return (
    <>
      {visibleSections.map((section, sectionIdx) => (
        <div key={section.label ?? `section-${sectionIdx}`} role="group" aria-label={section.label}>
          {sectionIdx > 0 && (
            <Separator className="my-2" />
          )}
          {section.label && !collapsed && (
            <span
              className="mb-1 block px-3 pt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]"
              aria-hidden="true"
            >
              {section.label}
            </span>
          )}
          {section.items.map((item) => (
            <SidebarNavItem
              key={item.href}
              item={item}
              active={isActive(effectivePathname, item)}
              collapsed={collapsed}
              accentVar={accentColor}
            />
          ))}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main sidebar component
// ---------------------------------------------------------------------------

/**
 * Generic collapsible sidebar used by both the firm dashboard and admin panel.
 *
 * Features:
 * - Collapsed (icon-only, w-16) / expanded (w-56) modes
 * - Sectioned navigation with optional section headers
 * - Active state detection via pathname
 * - Keyboard shortcut: Cmd+/ (Mac) or Ctrl+/ (Windows/Linux) toggles collapse
 * - Tooltip on collapsed items showing the label
 * - Scrollable nav area with fixed header and footer
 */
export function Sidebar({
  sections,
  collapsed,
  onToggleCollapse,
  logo,
  footer,
  accentColor = '--color-accent',
}: SidebarProps) {
  // -----------------------------------------------------------------------
  // Keyboard shortcut: Cmd+/ or Ctrl+/
  // -----------------------------------------------------------------------
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === '/' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onToggleCollapse();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onToggleCollapse]);

  return (
    <TooltipProvider disableHoverableContent>
      <aside
        className={cn(
          'flex h-full flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)] transition-all duration-200',
          collapsed ? 'w-16' : 'w-56',
        )}
        aria-label="Sidebar navigation"
      >
        {/* ---- Header: logo + collapse toggle ---- */}
        <div
          className={cn(
            'flex h-14 shrink-0 items-center border-b border-[var(--color-border)] px-3',
            collapsed ? 'justify-center' : 'justify-between',
          )}
        >
          {!collapsed && <div className="truncate">{logo}</div>}
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={onToggleCollapse}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!collapsed}
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              <span className="ml-2 text-xs text-[var(--color-muted)]">
                {typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)
                  ? '\u2318/'
                  : 'Ctrl+/'}
              </span>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* ---- Scrollable nav sections ---- */}
        <ScrollArea className="flex-1">
          <nav className="flex flex-col gap-1 p-2" aria-label="Main navigation">
            <SidebarNav sections={sections} collapsed={collapsed} accentColor={accentColor} />
          </nav>
        </ScrollArea>

        {/* ---- Footer ---- */}
        <div
          className={cn(
            'shrink-0 border-t border-[var(--color-border)] p-2',
            collapsed && 'flex justify-center',
          )}
        >
          {footer}
        </div>
      </aside>
    </TooltipProvider>
  );
}
