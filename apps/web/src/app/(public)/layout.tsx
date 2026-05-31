import Link from 'next/link';
import { CrivacyLogo } from '@/components/shared/crivacy-logo';
import { ThemeToggle } from '@/components/shared/theme-toggle';

export default function PublicLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg)]">
      {/* Header */}
      <header className="border-b border-[var(--color-border)] px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center text-[var(--color-fg)] transition-colors hover:text-[var(--color-accent)]"
          >
            <CrivacyLogo className="h-6" />
          </Link>
          <ThemeToggle />
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {children}
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--color-border)] px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-3xl gap-1 text-xs text-[var(--color-muted)]">
          <Link href="/terms" className="transition-colors hover:text-[var(--color-accent)]">
            Terms
          </Link>
          <span aria-hidden="true">&middot;</span>
          <Link href="/privacy" className="transition-colors hover:text-[var(--color-accent)]">
            Privacy
          </Link>
        </div>
      </footer>
    </div>
  );
}
