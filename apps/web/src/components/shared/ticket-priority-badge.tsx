import { StatusBadge, type StatusBadgeProps } from '@/components/shared/status-badge';

/* -------------------------------------------------------------------------- */
/*  Priority mapping                                                          */
/* -------------------------------------------------------------------------- */

type PriorityVariant = NonNullable<StatusBadgeProps['status']>;

const PRIORITY_MAP: Record<string, { readonly label: string; readonly variant: PriorityVariant }> = {
  low: { label: 'Low', variant: 'neutral' },
  normal: { label: 'Normal', variant: 'info' },
  high: { label: 'High', variant: 'warning' },
  urgent: { label: 'Urgent', variant: 'danger' },
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

interface TicketPriorityBadgeProps {
  readonly priority: string;
  readonly className?: string;
}

/**
 * Badge specialized for ticket priority levels.
 * Maps priority strings to colored StatusBadge variants. Shows a
 * dot indicator so it reads visually identical to status badges
 * (same padding + leading dot means "Low" and "Awaiting Response"
 * sit on the same baseline and neither appears left-shifted).
 */
export function TicketPriorityBadge({ priority, className }: TicketPriorityBadgeProps) {
  const mapped = PRIORITY_MAP[priority];
  const label = mapped?.label ?? priority;
  const variant = mapped?.variant ?? 'neutral';

  return (
    <StatusBadge status={variant} className={className}>
      {label}
    </StatusBadge>
  );
}
