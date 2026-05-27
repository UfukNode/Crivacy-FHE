import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: '404 · Not Found',
};

export default function DashboardNotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-[var(--color-fg)]">404</h1>
        <p className="mt-4 text-lg text-[var(--color-muted)]">Page not found</p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          The page you are looking for does not exist or has been moved.
        </p>
        <div className="mt-8 flex justify-center gap-4">
          <Link
            href="/dashboard"
            className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Back to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
