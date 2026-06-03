import { StatusBadge, type StatusBadgeProps } from '@/components/shared/status-badge';

/* -------------------------------------------------------------------------- */
/*  Status mapping                                                            */
/* -------------------------------------------------------------------------- */

type TicketStatusVariant = NonNullable<StatusBadgeProps['status']>;

const STATUS_MAP: Record<string, { readonly label: string; readonly variant: TicketStatusVariant }> = {
  open: { label: 'Open', variant: 'info' },
  in_progress: { label: 'In Progress', variant: 'warning' },
  waiting_customer: { label: 'Awaiting Response', variant: 'warning' },
  resolved: { label: 'Resolved', variant: 'success' },
  closed: { label: 'Closed', variant: 'neutral' },
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

interface TicketStatusBadgeProps {
  readonly status: string;
  readonly className?: string;
}

/**
 * Status badge specialized for ticket statuses.
 * Maps ticket status strings to colored StatusBadge variants.
 */
export function TicketStatusBadge({ status, className }: TicketStatusBadgeProps) {
  const mapped = STATUS_MAP[status];
  const label = mapped?.label ?? status.replace(/_/g, ' ');
  const variant = mapped?.variant ?? 'neutral';

  return (
    <StatusBadge status={variant} className={className}>
      {label}
    </StatusBadge>
  );
}
