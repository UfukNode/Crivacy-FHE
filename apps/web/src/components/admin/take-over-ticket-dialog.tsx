'use client';

/**
 * Admin ticket detail, Take-over dialog (superadmin-only).
 *
 * Exposes the privileged override path at
 * `POST /api/internal/admin/tickets/:id/take-over`. Only surfaced when
 * `viewer.capabilities.takeOver` is true, the server re-checks.
 *
 * A take-over forcibly reassigns the ticket to the caller (a superadmin)
 * regardless of the current assignee. The displaced assignee is offered
 * the same "stay as collaborator" courtesy as a regular reassign, with
 * the default ON, take-overs are meant to unblock, not punish.
 *
 * The reason field is optional at the schema level but strongly
 * encouraged; superadmin overrides that show up in audit logs without
 * justification are the ones compliance reviewers flag. We surface the
 * field with a "recommended" hint rather than enforcing it client-side
 * so handlers remain the source of truth.
 *
 * @module
 */

import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { LoadingButton } from '@/components/shared/loading-button';

const REASON_MAX = 500;

export interface TakeOverTicketDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Display name of the admin the ticket is currently assigned to. */
  readonly currentAssigneeName: string;
  /** Submission in flight, disables the form and blocks dismissal. */
  readonly submitting: boolean;
  /** Latest server error, surfaced inline above the form. */
  readonly error: string | null;
  /**
   * Called when the user confirms. Parent performs the POST, refreshes
   * SWR, and closes on success.
   */
  readonly onConfirm: (
    reason: string | undefined,
    previousAssigneeStaysAsCollab: boolean,
  ) => void | Promise<void>;
}

/**
 * Take-over confirmation dialog. Controlled component, state reset on open.
 */
export function TakeOverTicketDialog({
  open,
  onOpenChange,
  currentAssigneeName,
  submitting,
  error,
  onConfirm,
}: TakeOverTicketDialogProps) {
  const [reason, setReason] = React.useState('');
  const [stayAsCollab, setStayAsCollab] = React.useState(true);
  const [localError, setLocalError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setReason('');
      setStayAsCollab(true);
      setLocalError(null);
    }
  }, [open]);

  async function handleConfirm(): Promise<void> {
    const trimmed = reason.trim();
    if (trimmed.length > REASON_MAX) {
      setLocalError(`Explanation must be at most ${REASON_MAX} characters.`);
      return;
    }
    setLocalError(null);
    await onConfirm(trimmed.length === 0 ? undefined : trimmed, stayAsCollab);
  }

  const shownError = localError ?? error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Take over ticket</DialogTitle>
          <DialogDescription>
            Assignment will move from <strong>{currentAssigneeName}</strong>{' '}
            to you. This action is a privileged override and is logged in
            the audit trail.
          </DialogDescription>
        </DialogHeader>

        {shownError !== null && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
            {shownError}
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="take-over-reason"
              className="text-xs font-medium text-[var(--color-muted)]"
            >
              Reason <span className="text-[var(--color-muted)]">(recommended)</span>
            </label>
            <Textarea
              id="take-over-reason"
              value={reason}
              onChange={(e) => { setReason(e.target.value); }}
              maxLength={REASON_MAX}
              rows={3}
              placeholder="e.g. Previous assignee unavailable; customer escalation requires immediate response."
              disabled={submitting}
              autoFocus
            />
            <p className="text-right text-xs text-[var(--color-muted)]">
              {reason.length}/{REASON_MAX}
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={stayAsCollab}
              onChange={(e) => { setStayAsCollab(e.target.checked); }}
              disabled={submitting}
              className="mt-0.5 rounded border-[var(--color-border)]"
            />
            <span className="flex-1">
              Keep <strong>{currentAssigneeName}</strong> as a collaborator
              <span className="block text-xs text-[var(--color-muted)]">
                They will still receive updates and can reply. Uncheck to
                remove them entirely.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => { onOpenChange(false); }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <LoadingButton
            variant="destructive"
            loading={submitting}
            onClick={() => { void handleConfirm(); }}
          >
            Take over
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
