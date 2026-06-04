'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from 'sonner';

import type { NavItem, NavSection } from '@/components/shared/nav-config';

/**
 * Route-level permission guard.
 *
 * Given a nav-config tree and the caller's permission predicate, walks
 * the current pathname against nav items and redirects when the
 * caller lacks the declared permission for the active page. Runs
 * client-side after the permission set has loaded — there's no point
 * redirecting while `hasPermission` is still returning `false` for
 * everything (initial loading state).
 *
 * This is a UX layer. The real security boundary is the server-side
 * endpoint middleware — a user who bypasses this hook (devtools,
 * direct fetch) still gets 403 from the API. The redirect exists
 * only so permission-less users don't stare at a page that will never
 * load its data.
 *
 *   useRouteGuard(DASHBOARD_NAV, hasFirmPermission, '/dashboard', {
 *     ready: !isLoadingPermissions,
 *   });
 *
 * `ready=false` suppresses the redirect — useful while SWR is
 * fetching the permission set for the first time. Without this guard,
 * every page would flash a "no access" redirect on initial load.
 */
export interface UseRouteGuardOptions {
  /**
   * Whether the permission set has finished loading. When `false`,
   * no redirect fires regardless of the current pathname. Pass the
   * inverse of the hook's `isLoading` flag.
   */
  readonly ready: boolean;
  /** Pathname to redirect to when the guard denies. Defaults to `fallbackHref`. */
  readonly deniedRedirect?: string;
  /** Toast message on denial. Defaults to a generic message. */
  readonly deniedMessage?: string;
}

/**
 * Flatten a `NavSection[]` tree into a list of (href, permission?)
 * pairs. Sorted by href length descending so a longest-prefix match
 * hits `/dashboard/api-keys/:id` before `/dashboard/api-keys`.
 */
function buildPermissionIndex(sections: readonly NavSection[]): readonly {
  readonly href: string;
  readonly permission: string | undefined;
  readonly end: boolean;
}[] {
  const items: { href: string; permission: string | undefined; end: boolean }[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      items.push({
        href: item.href,
        permission: item.permission,
        end: item.end === true,
      });
    }
  }
  // Longest prefix first so nested routes find their closest match.
  return items.sort((a, b) => b.href.length - a.href.length);
}

function matchItem(
  pathname: string,
  items: readonly {
    readonly href: string;
    readonly permission: string | undefined;
    readonly end: boolean;
  }[],
): { permission: string | undefined } | null {
  for (const item of items) {
    if (item.end) {
      if (pathname === item.href) return { permission: item.permission };
    } else {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
        return { permission: item.permission };
      }
    }
  }
  return null;
}

export function useRouteGuard(
  sections: readonly NavSection[],
  hasPermission: (code: string) => boolean,
  fallbackHref: string,
  options: UseRouteGuardOptions,
): void {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!options.ready) return;

    // Build the index once per render — could be memoised outside the
    // hook if the nav tree becomes hot, but NavSection arrays are
    // frozen module-level constants so the compiler dedups the work.
    const index = buildPermissionIndex(sections);
    if (pathname === null) return;
    const match = matchItem(pathname, index);

    // No matching nav item → we don't know what permission this page
    // requires, so we don't redirect. Common case: pages not in the
    // sidebar (deep links like `/dashboard/accept-invite`). The
    // server-side middleware still enforces whatever permission the
    // route handler declares.
    if (match === null) return;

    // Item exists in nav but declares no permission → open to every
    // signed-in user of this portal. Nothing to do.
    if (match.permission === undefined) return;

    if (!hasPermission(match.permission)) {
      toast.error(options.deniedMessage ?? 'You do not have access to that page.');
      router.replace(options.deniedRedirect ?? fallbackHref);
    }
  }, [
    pathname,
    sections,
    hasPermission,
    fallbackHref,
    options.ready,
    options.deniedRedirect,
    options.deniedMessage,
    router,
  ]);
}
