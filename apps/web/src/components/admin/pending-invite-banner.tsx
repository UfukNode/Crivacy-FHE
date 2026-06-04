'use client';

import * as React from 'react';

import { LoadingButton } from '@/components/shared/loading-button';
import { Button } from '@/components/ui/button';
import { useAdminTicketAction } from '@/hooks/use-admin-tickets';
import { Inbox } from 'lucide-react';

export interface PendingInviteBannerProps {
  readonly ticketId: string;
  readonly inviteRole: 'assignee' | 'collaborator';
  readonly onResolved: () => void | Promise<void>;
}

/**
 * Banner shown at the top of the ticket detail page when the caller has a
 * pending invitation on the ticket. Accepting activates the participant
 * row (caller gains full access to the thread, including internal notes
 * on the next fetch). Declining records the response and removes their
 * access on the next request.
 *
 * This component is the ONLY surface a pending invitee uses to enter the
 * ticket -- mutations (reply / reassign / internal_note) remain blocked
 * server-side until their row flips to `active`.
 */
export function PendingInviteBanner({
  ticketId,
  inviteRole,
  onResolved,
}: PendingInviteBannerProps) {
  const { execute } = useAdminTicketAction();
  const [submitting, setSubmitting] = React.useState<'accept' | 'decline' | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleAccept = React.useCallback(async () => {
    setSubmitting('accept');
    setError(null);
    try {
      const res = await execute(
        `/api/internal/admin/tickets/${ticketId}/participants/accept`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(data?.message ?? 'Failed to accept invitation.');
        setSubmitting(null);
        return;
      }
      setSubmitting(null);
      await onResolved();
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(null);
    }
  }, [execute, onResolved, ticketId]);

  const handleDecline = React.useCallback(async () => {
    setSubmitting('decline');
    setError(null);
    try {
      const res = await execute(
        `/api/internal/admin/tickets/${ticketId}/participants/decline`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(data?.message ?? 'Failed to decline invitation.');
        setSubmitting(null);
        return;
      }
      setSubmitting(null);
      await onResolved();
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(null);
    }
  }, [execute, onResolved, ticketId]);

  const roleLabel = inviteRole === 'assignee' ? 'take over as assignee' : 'collaborate';

  return (
    <div
      role="region"
      aria-label="Pending invitation"
      className="rounded-[var(--radius-md)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-warning)]/20 text-[var(--color-warning)]">
            <Inbox className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-[var(--color-fg)]">
              You have a pending invitation to {roleLabel} on this ticket.
            </p>
            <p className="text-xs text-[var(--color-muted)]">
              Accept to join the thread. Internal notes remain hidden until you accept.
            </p>
          </div>
        </div>
        <div className="flex gap-2 sm:shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void handleDecline();
            }}
            disabled={submitting !== null}
          >
            Decline
          </Button>
          <LoadingButton
            size="sm"
            loading={submitting === 'accept'}
            disabled={submitting === 'decline'}
            onClick={() => {
              void handleAccept();
            }}
          >
            Accept
          </LoadingButton>
        </div>
      </div>
      {error !== null && (
        <p
          role="alert"
          className="mt-2 text-xs text-[var(--color-danger)]"
        >
          {error}
        </p>
      )}
    </div>
  );
}
