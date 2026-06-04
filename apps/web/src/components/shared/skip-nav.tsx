/**
 * Skip navigation link for accessibility.
 * First element in <body>, visually hidden until focused.
 */
export function SkipNav() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:inline-flex focus:min-h-[44px] focus:items-center focus:rounded-[var(--radius-md)] focus:bg-[var(--color-accent)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--color-accent-contrast)] focus:outline-none"
    >
      Skip to main content
    </a>
  );
}
