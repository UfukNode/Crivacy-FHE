'use client';

import { useEffect } from 'react';

interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    // In production this hook is where OTel span + pino error log should fire.
    // The observability wiring is the responsibility of step 18 (OTel instrumentation).
    if (process.env['NODE_ENV'] !== 'production') {
      // eslint-disable-next-line no-console
      console.error('[crivacy:web] unhandled render error', error);
    }
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-start justify-center gap-4 px-6 py-24">
      <p className="text-danger font-mono text-xs uppercase tracking-wider">Error</p>
      <h1 className="text-fg text-3xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-muted text-base">
        An unexpected error occurred while rendering the page. You can try again or return to the
        home page.
      </p>
      {error.digest ? <p className="text-muted font-mono text-xs">digest: {error.digest}</p> : null}
      <button
        type="button"
        onClick={reset}
        className="border-border bg-surface text-fg inline-flex h-10 items-center rounded-md border px-4 text-sm transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        Try again
      </button>
    </main>
  );
}
