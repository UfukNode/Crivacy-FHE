'use client';

/**
 * Admin ticket detail, Reassign dialog.
 *
 * Opened when the assignee Select in the ticket actions sidebar is changed
 * from one admin to another (A → B, where both sides are real admins).
 * Collects the two fields the backend needs for an explicit reassign:
 *
 *  - `reassignReason`, free-form explanation (required, 1-500 chars),
 *    persisted on the outgoing assignee's participant row so audit
 *    readers can see *why* the transfer happened.
 *  - `oldAssigneeStaysAsCollab`, when checked (default), the previous
 *    assignee is demoted to an active collaborator rather than removed
 *    from the ticket. The default is deliberate: most reassigns are
 *    hand-offs, not ejections.
 *
 * Self-claims, unassign (A → null), and initial assignment (null → A)
 * bypass this dialog, the backend explicitly ignores these fields for
 * those transitions and the UI should not pretend a reason is required.
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
const REASON_MIN = 1;

export interface ReassignTicketDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Display name of the admin currently holding the assignee role. */
  readonly currentAssigneeName: string;
  /** Display name of the admin the ticket is being reassigned to. */
  readonly newAssigneeName: string;
  /** Submission in flight, disables the form and blocks dismissal. */
  readonly submitting: boolean;
  /** Latest server error, surfaced inline above the form. */
  readonly error: string | null;
  /**
   * Called when the user confirms. The parent is responsible for
   * performing the PATCH, refreshing SWR, and closing the dialog on
   * success. Only invoked when `reason` is non-empty after trim.
   */
  readonly onConfirm: (reason: string, oldAssigneeStaysAsCollab: boolean) => void | Promise<void>;
}

/**
 * Reassign confirmation dialog. Controlled component, state reset on open.
 */
export function ReassignTicketDialog({
  open,
  onOpenChange,
  currentAssigneeName,
  newAssigneeName,
  submitting,
  error,
  onConfirm,
}: ReassignTicketDialogProps) {
  const [reason, setReason] = React.useState('');
  const [stayAsCollab, setStayAsCollab] = React.useState(true);
  const [localError, setLocalError] = React.useState<string | null>(null);

  // Reset state every time the dialog is (re)opened so a prior attempt
  // doesn't leak into the next one.
  React.useEffect(() => {
    if (open) {
      setReason('');
      setStayAsCollab(true);
      setLocalError(null);
    }
  }, [open]);

  async function handleConfirm(): Promise<void> {
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) {
      setLocalError('Please provide a short explanation.');
      return;
    }
    if (trimmed.length > REASON_MAX) {
      setLocalError(`Explanation must be at most ${REASON_MAX} characters.`);
      return;
    }
    setLocalError(null);
    await onConfirm(trimmed, stayAsCollab);
  }

  const shownError = localError ?? error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign ticket</DialogTitle>
          <DialogDescription>
            Transfer assignment from <strong>{currentAssigneeName}</strong>{' '}
            to <strong>{newAssigneeName}</strong>. Please explain why, the
            previous assignee will see this reason.
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
              htmlFor="reassign-reason"
              className="text-xs font-medium text-[var(--color-muted)]"
            >
              Reason
            </label>
            <Textarea
              id="reassign-reason"
              value={reason}
              onChange={(e) => { setReason(e.target.value); }}
              maxLength={REASON_MAX}
              rows={3}
              placeholder="e.g. Customer requested follow-up in German; routing to the DE desk."
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
                They will still receive updates and can reply, but will no
                longer be the assignee. Uncheck to remove them entirely.
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
            loading={submitting}
            disabled={reason.trim().length === 0}
            onClick={() => { void handleConfirm(); }}
          >
            Reassign
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
