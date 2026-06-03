import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const statusBadgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      status: {
        success: 'bg-[var(--color-success)]/15 text-[var(--color-success)]',
        warning: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]',
        danger: 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]',
        info: 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]',
        neutral: 'bg-[var(--color-muted)]/15 text-[var(--color-muted)]',
        // Tier variants, used for credential / KYC level pills so they
        // sit visually distinct from the status pill (success/danger/etc)
        // they share a row with. Sky for basic (entry tier), violet for
        // enhanced (premium tier).
        'tier-basic': 'bg-sky-500/15 text-sky-300',
        'tier-enhanced': 'bg-violet-500/15 text-violet-300',
      },
    },
    defaultVariants: {
      status: 'neutral',
    },
  },
);

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusBadgeVariants> {
  /** Dot indicator before label */
  dot?: boolean;
}

/**
 * Colored badge for any status enum.
 * Maps to: success (green), warning (amber), danger (red), info (accent), neutral (muted).
 */
export function StatusBadge({ status, dot = true, className, children, ...props }: StatusBadgeProps) {
  return (
    <span
      className={cn(statusBadgeVariants({ status }), className)}
      role="status"
      aria-label={`Status: ${children}`}
      {...props}
    >
      {dot && (
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            status === 'success' && 'bg-[var(--color-success)]',
            status === 'warning' && 'bg-[var(--color-warning)]',
            status === 'danger' && 'bg-[var(--color-danger)]',
            status === 'info' && 'bg-[var(--color-accent)]',
            status === 'neutral' && 'bg-[var(--color-muted)]',
          )}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
