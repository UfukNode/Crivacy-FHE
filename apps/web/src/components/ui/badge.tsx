import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-[var(--color-accent)] text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent)]/80',
        secondary:
          'border-transparent bg-[var(--color-surface)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]',
        destructive:
          'border-transparent bg-[var(--color-danger)] text-white hover:bg-[var(--color-danger)]/80',
        outline: 'border-[var(--color-border)] text-[var(--color-fg)]',
        success:
          'border-transparent bg-[var(--color-success)] text-white hover:bg-[var(--color-success)]/80',
        warning:
          'border-transparent bg-[var(--color-warning)] text-white hover:bg-[var(--color-warning)]/80',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => {
    return <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />;
  },
);
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
