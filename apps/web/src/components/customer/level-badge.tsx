import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Level → colour map                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Tailwind class sets for each KYC level. Uses semantic custom properties
 * where possible and falls back to Tailwind palette for mid-tier levels
 * that have no project-level token.
 */
const LEVEL_COLORS: Record<string, string> = {
  kyc_0: 'bg-[var(--color-muted)]/20 text-[var(--color-muted)]',
  kyc_1: 'bg-[var(--color-muted)]/20 text-[var(--color-muted)]',
  kyc_2: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  kyc_3: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
  kyc_4: 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]',
};

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface LevelBadgeProps {
  readonly level: string;
  readonly levelName: string;
  readonly className?: string;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Inline pill badge showing the customer's current KYC level name.
 * Colour varies by level to give an immediate visual indicator.
 */
export function LevelBadge({ level, levelName, className }: LevelBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        LEVEL_COLORS[level] ?? LEVEL_COLORS['kyc_0'],
        className,
      )}
      role="status"
      aria-label={`KYC level: ${levelName}`}
    >
      {levelName}
    </span>
  );
}
