/**
 * Docs layout -- outer shell for every page under `(docs)/`.
 *
 * Provides:
 *   - Fixed header with "Crivacy Docs" branding, search trigger, and
 *     a link back to the main marketing site.
 *   - A flex container that child pages fill with sidebar + content + TOC.
 *
 * The layout intentionally does NOT render the sidebar or TOC itself
 * because it has no access to the current slug (layouts do not receive
 * route params in the App Router model). Each page composes its own
 * three-column grid inside the `children` slot.
 *
 * @module
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import Link from 'next/link';

import { CrivacyLogo } from '@/components/shared/crivacy-logo';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { DocsSearch } from '@/components/docs/docs-search';
import { DocsMobileNav } from '@/components/docs/docs-mobile-nav';
import { buildDocsSearchIndex } from '@/lib/docs';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata: Metadata = {
  title: {
    default: 'Crivacy Docs',
    template: '%s -- Crivacy Docs',
  },
  description:
    'Developer documentation for the Crivacy KYC API. Learn how to integrate FHE-powered re-usable identity credentials into your application.',
  openGraph: {
    title: 'Crivacy Docs',
    description:
      'Developer documentation for the Crivacy KYC API. FHE-powered re-usable identity credentials.',
    siteName: 'Crivacy',
    locale: 'en_US',
    type: 'website',
  },
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export default function DocsLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Build the docs search index once per render on the server.
  // The index is small (dozens of entries) and purely a function
  // of on-disk MDX + the nav config, so the work is cheap and
  // doesn't need caching, Next's SSG / ISR will memoise it
  // naturally on production builds.
  const searchIndex = buildDocsSearchIndex();

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg)]">
      {/* ---------------------------------------------------------------- */}
      {/* Top header bar                                                   */}
      {/* ---------------------------------------------------------------- */}
      <header className="bg-[var(--color-bg)]/80 sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-[var(--color-border)] px-4 backdrop-blur-md sm:px-6">
        <DocsMobileNav />
        {/* Branding, real Crivacy owl logo, tinted via currentColor
            so the same markup works in both light and dark themes. */}
        <Link
          href="/docs"
          aria-label="Crivacy documentation home"
          className="flex items-center gap-2.5 text-[var(--color-fg)] transition-colors hover:text-[var(--color-accent)]"
        >
          <CrivacyLogo
            iconOnly
            className="h-6 w-6 text-[var(--color-accent)]"
          />
          <span className="text-sm font-semibold tracking-tight">Crivacy Docs</span>
        </Link>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Quick links */}
        <nav className="flex items-center gap-2" aria-label="Quick links">
          <DocsSearch index={searchIndex} />

          <Link
            href="/docs/api-reference"
            className="hidden rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] sm:inline-flex"
          >
            API Reference
          </Link>

          <Link
            href="/docs/changelog"
            className="hidden rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] sm:inline-flex"
          >
            Changelog
          </Link>

          {/* Separator */}
          <span className="mx-2 hidden h-4 w-px bg-[var(--color-border)] sm:block" />

          <ThemeToggle />

          {/* Back to main site */}
          <Link
            href="/"
            className="rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
          >
            crivacy.io
          </Link>
        </nav>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Content area -- pages render sidebar + main + toc here           */}
      {/* ---------------------------------------------------------------- */}
      <div className="mx-auto flex w-full max-w-[90rem] flex-1 px-4 sm:px-6 lg:px-8">
        {children}
      </div>
    </div>
  );
}
