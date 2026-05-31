/**
 * Status page layout, outer shell for `/status`.
 *
 * Provides:
 *   - Fixed header with "Crivacy Status" branding + link to main site
 *   - Centered content container
 *
 * @module
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import Link from 'next/link';

import { ThemeToggle } from '@/components/shared/theme-toggle';

export const metadata: Metadata = {
  title: {
    default: 'Crivacy Status',
    template: '%s -- Crivacy Status',
  },
  description:
    'Real-time system status for the Crivacy KYC API. View component health, uptime history, and active incidents.',
  openGraph: {
    title: 'Crivacy Status',
    description: 'Real-time system status for the Crivacy KYC API.',
    siteName: 'Crivacy',
    locale: 'en_US',
    type: 'website',
  },
};

export default function StatusLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg)]">
      {/* Header */}
      <header className="bg-[var(--color-bg)]/80 sticky top-0 z-40 flex h-14 items-center border-b border-[var(--color-border)] px-4 backdrop-blur-md sm:px-6">
        <Link
          href="/status"
          className="flex items-center gap-2.5 text-[var(--color-fg)] transition-colors hover:text-[var(--color-accent)]"
        >
          <span className="flex h-7 w-7 select-none items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent)] text-xs font-bold text-white">
            C
          </span>
          <span className="text-sm font-semibold tracking-tight">Crivacy Status</span>
        </Link>

        <div className="flex-1" />

        <nav className="flex items-center gap-1" aria-label="Status navigation">
          <Link
            href="/docs"
            className="hidden rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] sm:inline-flex"
          >
            Docs
          </Link>
          <Link
            href="/"
            className="rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
          >
            crivacy.io
          </Link>
          <ThemeToggle />
        </nav>
      </header>

      {/* Content */}
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">{children}</main>

      {/* Footer */}
      <footer className="border-t border-[var(--color-border)] py-4 text-center text-xs text-[var(--color-muted)]">
        <p>
          Powered by{' '}
          <Link href="/" className="text-[var(--color-accent)] hover:underline">
            Crivacy
          </Link>
          {' | '}
          <Link href="/status/feed.xml" className="text-[var(--color-accent)] hover:underline">
            RSS Feed
          </Link>
        </p>
      </footer>
    </div>
  );
}
