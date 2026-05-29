/**
 * "Try it" button -- deep link to the API playground page.
 *
 * Used inside docs API reference sections to let authenticated users
 * jump straight to the playground with a specific endpoint pre-filled.
 * @module
 */

import Link from 'next/link';

interface TryItButtonProps {
  /** HTTP method (GET, POST, PATCH, DELETE, etc.). */
  readonly method: string;
  /** Full API path, e.g. `/api/v1/sessions`. */
  readonly path: string;
}

export function TryItButton({ method, path }: TryItButtonProps) {
  // Encode method + path as search params for the playground page
  const params = new URLSearchParams({ method: method.toUpperCase(), path });
  const href = `/dashboard/playground?${params.toString()}`;

  return (
    <Link
      href={href}
      className="border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 hover:bg-[var(--color-accent)]/20 hover:border-[var(--color-accent)]/50 inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border px-3 py-1.5 text-xs font-medium text-[var(--color-accent)] transition-colors duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
    >
      {/* Play icon */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="h-3.5 w-3.5"
        aria-hidden="true"
      >
        <path d="M3 3.732a1.5 1.5 0 0 1 2.305-1.265l6.706 4.267a1.5 1.5 0 0 1 0 2.531l-6.706 4.268A1.5 1.5 0 0 1 3 12.267V3.732Z" />
      </svg>
      Try it
    </Link>
  );
}
