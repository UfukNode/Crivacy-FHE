'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

/**
 * Navigation transition provider + layout wrapper.
 *
 * Problem being solved: our pages are Client Components that fetch
 * data via SWR, so Next.js' `loading.tsx` Suspense boundary never
 * suspends on nav, the new page mounts immediately with its own
 * `isLoading` state, and between click → fetch → commit there is a
 * ~100-600 ms window where the stale page stays on screen with NO
 * visual sign that the click registered. The nav item itself also
 * stays "unselected" because Next.js only flips `usePathname()` AFTER
 * commit, so the target sidebar button only highlights once the page
 * is already ready.
 *
 * The fix, in one moving part: intercept every internal link click
 * at the document level (capture phase so it fires BEFORE Next.js'
 * own `<Link>` preventDefault) and stash the destination href in a
 * context. Anything downstream that wants responsive UX reads the
 * context: the sidebar's active-state check, the content area's
 * skeleton swap, etc. When `usePathname()` finally commits, we clear
 * the pending href and the tree falls back to "real" state.
 *
 *   <NavigationTransitionProvider>
 *     <Sidebar /> ← uses `usePendingHref` for instant active state
 *     <RouteTransitionLayout fallback={<LoadingSkeleton />}>
 *       {page}    ← replaced by fallback while navigating
 *     </RouteTransitionLayout>
 *   </NavigationTransitionProvider>
 *
 * Safety timeout: if a navigation is cancelled / errors out the flag
 * could get stuck. After `SAFETY_TIMEOUT_MS` with no pathname change
 * we give up and clear it.
 *
 * The listener deliberately ignores middle-click, Ctrl/Meta/Shift,
 * external origins, `target="_blank"`, in-page anchors, mailto/tel,
 * and same-path clicks, none of those should steal focus from the
 * current page.
 */

const SAFETY_TIMEOUT_MS = 5000;

interface NavigationTransitionState {
  readonly pendingHref: string | null;
}

const NavigationTransitionContext = React.createContext<NavigationTransitionState>({
  pendingHref: null,
});

interface NavigationTransitionProviderProps {
  readonly children: React.ReactNode;
}

export function NavigationTransitionProvider({
  children,
}: NavigationTransitionProviderProps) {
  const pathname = usePathname();
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  const startedFromRef = React.useRef<string | null>(null);

  // Clear the pending flag as soon as the pathname moves away from
  // the pathname that was active when the click fired. This catches
  // both "navigation completed" and "user clicked two things in a
  // row" scenarios, whichever pathname lands wins.
  React.useEffect(() => {
    if (pendingHref === null) return;
    if (startedFromRef.current === null) return;
    if (startedFromRef.current !== pathname) {
      startedFromRef.current = null;
      setPendingHref(null);
    }
  }, [pathname, pendingHref]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    function handleClick(event: MouseEvent): void {
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest('a');
      if (anchor === null) return;
      if (anchor.target === '_blank') return;
      if (anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      if (href === null || href.length === 0) return;
      if (href.startsWith('#')) return;
      if (href.startsWith('mailto:') || href.startsWith('tel:')) return;

      let destination: URL;
      try {
        destination = new URL(href, window.location.origin);
      } catch {
        return;
      }
      if (destination.origin !== window.location.origin) return;
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search
      ) {
        return;
      }

      startedFromRef.current = window.location.pathname;
      setPendingHref(destination.pathname);
    }

    document.addEventListener('click', handleClick, true);
    return () => {
      document.removeEventListener('click', handleClick, true);
    };
  }, []);

  // Safety net: if the pending href never clears (cancelled / failed
  // navigation) reset after a few seconds so the UI doesn't stay
  // trapped on the skeleton.
  React.useEffect(() => {
    if (pendingHref === null) return;
    const timer = window.setTimeout(() => {
      startedFromRef.current = null;
      setPendingHref(null);
    }, SAFETY_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [pendingHref]);

  const value = React.useMemo<NavigationTransitionState>(
    () => ({ pendingHref }),
    [pendingHref],
  );

  return (
    <NavigationTransitionContext.Provider value={value}>
      {children}
    </NavigationTransitionContext.Provider>
  );
}

/**
 * Returns the destination pathname of the in-flight navigation, or
 * `null` when no navigation is pending. Downstream components use it
 * to render their "future" state immediately, e.g. a sidebar item
 * becomes active even though `usePathname()` has not committed yet.
 */
export function usePendingHref(): string | null {
  return React.useContext(NavigationTransitionContext).pendingHref;
}

interface RouteTransitionLayoutProps {
  readonly fallback: React.ReactNode;
  readonly children: React.ReactNode;
  /**
   * Return `true` to KEEP the current children mounted (i.e. skip
   * showing the fallback) for a given in-flight navigation. Lets an
   * outer layout opt out of its full-page skeleton when the user is
   * only switching between sub-routes that share a nested layout —
   * the nested layout can then swap its own smaller content-area
   * skeleton without the outer one flashing the entire chrome.
   *
   * Called with the destination href and the current pathname. Pure
   * visual, no security implications.
   */
  readonly skipFor?: (pendingHref: string, pathname: string) => boolean;
}

/**
 * Swaps children for the provided fallback while a navigation is in
 * flight (the provider has a pending href). The component must live
 * inside a {@link NavigationTransitionProvider}; outside of one it
 * degrades to a no-op (`pendingHref` is always `null`) so the page
 * still renders correctly.
 *
 * Nested usage: an inner layout can wrap its own content in another
 * `RouteTransitionLayout` with a lighter fallback; the outer layout
 * can pass a `skipFor` predicate so it yields to the inner one when
 * the navigation stays within the inner's scope.
 */
export function RouteTransitionLayout({
  fallback,
  children,
  skipFor,
}: RouteTransitionLayoutProps) {
  const pendingHref = usePendingHref();
  const pathname = usePathname();

  if (pendingHref !== null) {
    if (skipFor !== undefined && skipFor(pendingHref, pathname ?? '')) {
      return <>{children}</>;
    }
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
