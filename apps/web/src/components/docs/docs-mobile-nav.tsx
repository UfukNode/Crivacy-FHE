'use client';

/**
 * Mobile docs drawer.
 *
 * The desktop sidebar (`<DocsSidebar variant="desktop">`) lives in
 * the page tree and only paints on `md` and up. On smaller screens
 * it disappears entirely, so there's no way to reach a sibling
 * page without knowing the URL. This component fills the gap:
 *
 *   * A hamburger button, only visible below the `md` breakpoint.
 *   * An overlay + slide-in panel that mounts the same
 *     `<DocsSidebar>` content inside a dialog.
 *   * Closes on backdrop click, Escape, or any link navigation
 *     (every link is an `<a href>` so the `click` delegated
 *     listener catches the nav before the route change).
 *
 * Stays scoped to mobile, the presence check is entirely CSS so
 * we don't waste a hydration cycle rendering the button on
 * desktops.
 */

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

import { DocsSidebar } from './docs-sidebar';

export function DocsMobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Every pathname change closes the drawer, handles the case
  // where the drawer is open and the user picks a link (the link
  // updates the URL via Next's router, which flips `pathname`).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape-to-close + body scroll lock while the drawer is up.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  // Derive the current slug from the pathname. `/docs` → '',
  // `/docs/oauth` → 'oauth', `/docs/api-reference` → 'api-reference'.
  const currentSlug =
    pathname?.startsWith('/docs/') === true ? pathname.slice('/docs/'.length) : '';

  return (
    <>
      <button
        type="button"
        aria-label="Open documentation navigation"
        aria-expanded={open}
        aria-controls="docs-mobile-nav"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] md:hidden"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 5A.75.75 0 012.75 9h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 9.75zM2 14.75A.75.75 0 012.75 14h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div
          id="docs-mobile-nav"
          role="dialog"
          aria-modal="true"
          aria-label="Documentation navigation"
          className="fixed inset-0 z-50 md:hidden"
        >
          <button
            type="button"
            aria-label="Close navigation"
            onClick={close}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <div className="relative ml-auto flex h-full w-[min(85vw,20rem)] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] p-4 shadow-[var(--shadow-lg)]">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                Documentation
              </span>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M4.28 3.22a.75.75 0 00-1.06 1.06L8.94 10l-5.72 5.72a.75.75 0 101.06 1.06L10 11.06l5.72 5.72a.75.75 0 101.06-1.06L11.06 10l5.72-5.72a.75.75 0 00-1.06-1.06L10 8.94 4.28 3.22z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
            <DocsSidebar currentSlug={currentSlug} variant="mobile" />
          </div>
        </div>
      )}
    </>
  );
}
