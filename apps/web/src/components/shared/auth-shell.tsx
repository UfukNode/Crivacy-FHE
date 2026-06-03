import type { ReactNode } from 'react';
import Link from 'next/link';

import { CrivacyLogo } from '@/components/shared/crivacy-logo';
import { ThemeToggle } from '@/components/shared/theme-toggle';

/**
 * Single chrome for every unauthenticated entry point, customer
 * `/login` + `/register` + `/forgot-password` + `/reset-password`,
 * firm `/dashboard/login` + `/dashboard/forgot-password` +
 * `/dashboard/reset-password`, and admin `/admin/login`.
 *
 * What lives here:
 *   - The gradient background so all three portals look like the
 *     same product.
 *   - A centered {@link CrivacyLogo} above the content.
 *   - A Terms · Privacy footer below the content.
 *
 * Pages render their own Card (or inline form in admin's case) as
 * `children`. Keeping the Card at the page level lets each flow
 * pick its own width, title, description, and footer links without
 * this shell growing props for every variation.
 */
export interface AuthShellProps {
  readonly children: ReactNode;
  /**
   * Width cap for the inner column. Defaults to `max-w-md` which
   * matches the customer auth pages. Admin login historically used
   * `max-w-sm`; it can opt in via this prop.
   */
  readonly contentWidthClass?: string;
}

export function AuthShell({ children, contentWidthClass = 'max-w-md' }: AuthShellProps) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-gradient-to-br from-[var(--color-bg)] via-[var(--color-surface)] to-[var(--color-bg)] p-4">
      {/* Theme toggle pinned top-right so the unauthenticated chrome
          carries the same dark/light affordance as the authenticated
          shells. Same `<ThemeToggle />` component the dashboard +
          admin layouts mount, so localStorage `crivacy-theme` and
          `<html data-theme>` updates stay coherent across portals. */}
      <header className="absolute right-4 top-4 z-10">
        <ThemeToggle />
      </header>

      {/* `<main id="main-content">` is the SkipNav target (root layout
          mounts a single skip-link with `href="#main-content"`).
          `tabIndex={-1}` lets the skip-link push keyboard focus into
          this region without adding it to the tab order; the focus
          ring is suppressed because the user is already where they
          asked to go. */}
      <main
        id="main-content"
        tabIndex={-1}
        className={`w-full ${contentWidthClass} focus:outline-none`}
      >
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="inline-flex min-h-[44px] items-center justify-center text-[var(--color-fg)] transition-colors hover:text-[var(--color-accent)]"
          >
            <CrivacyLogo className="mx-auto h-9" />
          </Link>
        </div>

        {children}

        <footer className="mt-6 flex items-center justify-center gap-1 text-xs text-[var(--color-muted)]">
          <Link
            href="/terms"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center transition-colors hover:text-[var(--color-accent)]"
          >
            Terms
          </Link>
          <span aria-hidden="true">&middot;</span>
          <Link
            href="/privacy"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center transition-colors hover:text-[var(--color-accent)]"
          >
            Privacy
          </Link>
        </footer>
      </main>
    </div>
  );
}
