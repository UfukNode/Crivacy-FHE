'use client';

import { PendingInviteBanner } from '@/components/admin/pending-invite-banner';
import { ReassignTicketDialog } from '@/components/admin/reassign-ticket-dialog';
import { TakeOverTicketDialog } from '@/components/admin/take-over-ticket-dialog';
import { TicketParticipantsCard } from '@/components/admin/ticket-participants-card';
import { LoadingButton } from '@/components/shared/loading-button';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { RelativeTime } from '@/components/shared/relative-time';
import { TicketMessage } from '@/components/shared/ticket-message';
import { TicketPriorityBadge } from '@/components/shared/ticket-priority-badge';
import { TicketStatusBadge } from '@/components/shared/ticket-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useAdminTicketAction,
  useAdminTicketDetail,
  useAdminUsers,
} from '@/hooks/use-admin-tickets';
import type { AdminTicket, AdminTicketViewer } from '@/hooks/use-admin-tickets';
import { useAdminUser } from '@/hooks/use-admin-user';
import { useHighlightMessageOnMount } from '@/hooks/use-highlight-message-on-mount';
import { cn } from '@/lib/utils';
import { ArrowLeft, ArrowRightLeft, CheckCircle, Lock, Send, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import * as React from 'react';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const REPLY_MAX_LENGTH = 5000;

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'waiting_customer', label: 'Waiting Customer' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
] as const;

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
] as const;

/* -------------------------------------------------------------------------- */
/*  Loading skeleton                                                          */
/* -------------------------------------------------------------------------- */

function AdminTicketDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-64 lg:col-span-2" />
        <Skeleton className="h-64" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-20" />
        <Skeleton className="ml-auto h-20 w-3/4" />
      </div>
      <Skeleton className="h-32" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Admin reply form                                                          */
/* -------------------------------------------------------------------------- */

interface AdminReplyFormProps {
  readonly ticketId: string;
  readonly ticketStatus: string;
  readonly onReplySent: () => void;
}

function AdminReplyForm({ ticketId, ticketStatus, onReplySent }: AdminReplyFormProps) {
  const [reply, setReply] = React.useState('');
  const [isInternal, setIsInternal] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { execute } = useAdminTicketAction();

  const isClosed = ticketStatus === 'closed';

  async function handleSend() {
    const trimmed = reply.trim();
    if (!trimmed) return;

    if (trimmed.length > REPLY_MAX_LENGTH) {
      setError(`Reply must be at most ${REPLY_MAX_LENGTH} characters.`);
      return;
    }

    setSending(true);
    setError(null);

    try {
      const res = await execute(`/api/internal/admin/tickets/${ticketId}/messages`, {
        method: 'POST',
        body: {
          body: trimmed,
          isInternal,
        },
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        setError((err?.['message'] as string | undefined) ?? 'Failed to send reply.');
        return;
      }

      setReply('');
      setIsInternal(false);
      onReplySent();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
    }
  }

  if (isClosed) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-center">
        <p className="text-sm text-[var(--color-muted)]">
          This ticket is closed. Reopen it to reply.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error !== null && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <textarea
          value={reply}
          onChange={(e) => { setReply(e.target.value); }}
          onKeyDown={handleKeyDown}
          maxLength={REPLY_MAX_LENGTH}
          rows={3}
          placeholder={isInternal ? 'Write an internal note... (not visible to customer)' : 'Type your reply... (Ctrl+Enter to send)'}
          disabled={sending}
          aria-label={isInternal ? 'Internal note' : 'Reply message'}
          className={cn(
            'flex-1 rounded-[var(--radius-md)] border bg-transparent px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-sm)] transition-colors duration-[var(--duration-base)] placeholder:text-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50 resize-y',
            isInternal
              ? 'border-[var(--color-warning)]/50 bg-[var(--color-warning)]/5'
              : 'border-[var(--color-border)]',
          )}
        />
        <LoadingButton
          loading={sending}
          onClick={() => { void handleSend(); }}
          disabled={!reply.trim()}
          size="default"
          className="self-end"
          aria-label={isInternal ? 'Post internal note' : 'Send reply'}
        >
          {isInternal ? <Lock className="h-4 w-4" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
          {isInternal ? 'Note' : 'Send'}
        </LoadingButton>
      </div>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <input
            type="checkbox"
            checked={isInternal}
            onChange={(e) => { setIsInternal(e.target.checked); }}
            className="rounded border-[var(--color-border)]"
          />
          <Lock className="h-3 w-3" aria-hidden="true" />
          Internal Note
          <span className="text-xs">(not visible to customer)</span>
        </label>
        <p className="text-xs text-[var(--color-muted)]">
          {reply.length}/{REPLY_MAX_LENGTH}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Ticket actions sidebar                                                    */
/* -------------------------------------------------------------------------- */

interface TicketActionsSidebarProps {
  readonly ticketId: string;
  readonly status: string;
  readonly priority: string;
  readonly assignedTo: string | null;
  readonly assignedToName: string | null;
  readonly customerEmail: string;
  readonly customerName: string | null;
  readonly creator: AdminTicket['creator'];
  readonly categoryName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly viewer: AdminTicketViewer;
  readonly onUpdated: () => void;
}

function TicketActionsSidebar({
  ticketId,
  status,
  priority,
  assignedTo,
  assignedToName,
  customerEmail,
  customerName,
  creator,
  categoryName,
  createdAt,
  updatedAt,
  viewer,
  onUpdated,
}: TicketActionsSidebarProps) {
  // Silence the legacy props lint, we keep them on the interface
  // because other call sites may still pass them; the creator block
  // below is what actually renders.
  void customerEmail;
  void customerName;
  const { execute } = useAdminTicketAction();
  const { user: currentAdmin } = useAdminUser();
  const { users: adminUsers, isLoading: adminUsersLoading } = useAdminUsers();
  const [updating, setUpdating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /**
   * Pending reassign target, when the assignee Select is changed from
   * one real admin to another, we stash the new id here and open the
   * reassign dialog rather than PATCHing immediately. The dialog
   * collects the reason + stay-as-collab preference before submitting.
   * Null means no reassign in flight.
   */
  const [reassignTargetId, setReassignTargetId] = React.useState<string | null>(null);
  const [reassignSubmitting, setReassignSubmitting] = React.useState(false);
  const [reassignError, setReassignError] = React.useState<string | null>(null);

  const [takeOverOpen, setTakeOverOpen] = React.useState(false);
  const [takeOverSubmitting, setTakeOverSubmitting] = React.useState(false);
  const [takeOverError, setTakeOverError] = React.useState<string | null>(null);
  // BUG #58: take-over POST requires password+TOTP reauth. The
  // dialog collects reason+stayAsCollab; on confirm we close the
  // dialog and open the reauth modal with the captured payload so
  // the privileged-override fetch carries the envelope.
  const [takeOverPending, setTakeOverPending] = React.useState<{
    readonly reason: string | undefined;
    readonly previousAssigneeStaysAsCollab: boolean;
  } | null>(null);

  async function handleUpdate(field: string, value: string | null) {
    setUpdating(true);
    setError(null);
    try {
      const res = await execute(`/api/internal/admin/tickets/${ticketId}`, {
        method: 'PATCH',
        body: { [field]: value },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        setError((err?.['message'] as string | undefined) ?? `Failed to update ${field}.`);
        return;
      }
      onUpdated();
    } catch {
      setError('Network error.');
    } finally {
      setUpdating(false);
    }
  }

  /**
   * Assignee Select handler.
   *
   * Only `A → B` (current assignee is a real admin AND new target is a
   * different real admin AND new target is not the caller) needs the
   * reassign dialog. All other transitions go straight through the
   * standard PATCH because the backend explicitly ignores
   * `reassignReason`/`oldAssigneeStaysAsCollab` on them:
   *
   *   - `null → admin`    initial assignment (no previous assignee)
   *   - `null → self`     self-claim from pool
   *   - `A → null`        unassign
   *   - `A → A`           no-op (ignored by React via controlled value)
   *   - `A → self`        claim from peer (backend treats as self-claim)
   */
  function handleAssigneeChange(newId: string | null): void {
    if (newId === assignedTo) return;
    const isViewer = currentAdmin !== null && newId === currentAdmin.id;
    const needsReassignDialog =
      assignedTo !== null && newId !== null && !isViewer;
    if (needsReassignDialog) {
      setReassignError(null);
      setReassignTargetId(newId);
      return;
    }
    void handleUpdate('assignedTo', newId);
  }

  async function handleReassignConfirm(
    reason: string,
    oldAssigneeStaysAsCollab: boolean,
  ): Promise<void> {
    if (reassignTargetId === null) return;
    setReassignSubmitting(true);
    setReassignError(null);
    try {
      const res = await execute(`/api/internal/admin/tickets/${ticketId}`, {
        method: 'PATCH',
        body: {
          assignedTo: reassignTargetId,
          reassignReason: reason,
          oldAssigneeStaysAsCollab,
        },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        setReassignError(
          (err?.['message'] as string | undefined) ?? 'Failed to reassign ticket.',
        );
        return;
      }
      setReassignTargetId(null);
      onUpdated();
    } catch {
      setReassignError('Network error. Please try again.');
    } finally {
      setReassignSubmitting(false);
    }
  }

  // Take-over: the dialog onConfirm captures the form values and
  // hands them off to the reauth modal. The actual POST happens
  // inside `handleTakeOverReauthConfirmed` once the envelope is
  // verified, splitting it this way keeps the dialog dumb and the
  // reauth contract identical to the other 16 sweep endpoints.
  function handleTakeOverPrepare(
    reason: string | undefined,
    previousAssigneeStaysAsCollab: boolean,
  ): void {
    setTakeOverError(null);
    setTakeOverPending({ reason, previousAssigneeStaysAsCollab });
  }

  async function handleTakeOverReauthConfirmed({
    currentPassword,
    totpCode,
  }: { currentPassword: string; totpCode: string }): Promise<void> {
    if (takeOverPending === null) return;
    setTakeOverSubmitting(true);
    try {
      const res = await execute(
        `/api/internal/admin/tickets/${ticketId}/take-over`,
        {
          method: 'POST',
          body: {
            currentPassword,
            totpCode,
            previousAssigneeStaysAsCollab: takeOverPending.previousAssigneeStaysAsCollab,
            ...(takeOverPending.reason !== undefined ? { reason: takeOverPending.reason } : {}),
          },
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        throw new Error(
          (err?.['message'] as string | undefined) ?? 'Failed to take over ticket.',
        );
      }
      setTakeOverPending(null);
      setTakeOverOpen(false);
      onUpdated();
    } finally {
      setTakeOverSubmitting(false);
    }
  }

  /**
   * When the user is an admin themselves but is not in the returned roster
   * (unlikely but possible if they were just locked after the list was
   * fetched), surface them as an extra option so the select still reflects
   * current assignment correctly and "Assign to me" is never broken.
   */
  const rosterContainsCurrent = currentAdmin
    ? adminUsers.some((u) => u.id === currentAdmin.id)
    : false;

  // `Select` uses "unassigned" as a sentinel because Radix forbids empty-string
  // values on `SelectItem`. We translate back to `null` before calling the API.
  const UNASSIGNED_VALUE = '__unassigned__';

  // Capability-driven render decisions. Each field collapses to a
  // read-only display when the caller lacks the corresponding
  // capability: a pending invitee, a collaborator (who can reply but
  // not change state), or a pickup-pool viewer who has not claimed
  // the ticket yet. Superadmin satisfies every flag by matrix design.
  const caps = viewer.capabilities;
  const isTerminal = status === 'resolved' || status === 'closed';

  // Quick Actions container is only rendered when the caller can
  // change status; inside it the available buttons depend on the
  // current state (open/progress/waiting → mark resolved + close;
  // resolved → close + reopen; closed → reopen only).
  const showQuickActions = caps.changeStatus;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Ticket Details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error !== null && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2 py-1 text-xs text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {/* Opened by, label changes with creator kind so the admin
            sees whether this is a B2C customer thread or a B2B firm
            thread at a glance. For firm tickets we also surface the
            subscription tier because support response priorities
            usually track tier (enterprise over free). */}
        <div>
          <p className="text-xs font-medium text-[var(--color-muted)]">
            {creator.kind === 'firm_user' ? 'Firm' : 'Customer'}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-[var(--color-fg)]">
            <span className="truncate">{creator.label}</span>
            {creator.kind === 'firm_user' && creator.firmTier !== null && (
              <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-accent)]">
                {creator.firmTier}
              </span>
            )}
          </p>
          <p className="text-xs text-[var(--color-muted)]">{creator.email}</p>
        </div>

        {/* Category */}
        <div>
          <p className="text-xs font-medium text-[var(--color-muted)]">Category</p>
          <p className="mt-0.5 text-sm text-[var(--color-fg)]">{categoryName}</p>
        </div>

        {/* Status, rendered ONLY when editable. Read-only viewers
            already see it as a badge in the ticket header, so showing
            it again in the sidebar is pure duplication. */}
        {caps.changeStatus && (
          <div>
            <label
              htmlFor="admin-ticket-status"
              className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
            >
              Status
            </label>
            <Select
              value={status}
              onValueChange={(value) => {
                void handleUpdate('status', value);
              }}
              disabled={updating}
            >
              <SelectTrigger id="admin-ticket-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Priority, same rule as Status: hidden for read-only
            viewers because the ticket header already carries the
            priority badge. */}
        {caps.changePriority && (
          <div>
            <label
              htmlFor="admin-ticket-priority"
              className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
            >
              Priority
            </label>
            <Select
              value={priority}
              onValueChange={(value) => {
                void handleUpdate('priority', value);
              }}
              disabled={updating}
            >
              <SelectTrigger id="admin-ticket-priority" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Assigned To, full Select for the assignee / superadmin
            (`reassign` capability), otherwise just display the current
            assignee's name. "Assign to me" is its own button, gated
            separately on `selfClaim` so a collaborator / pool viewer
            can still grab an unassigned ticket without the full
            reassign dropdown. Take-over is superadmin-only. */}
        <div>
          <label
            htmlFor={caps.reassign ? 'admin-ticket-assigned-to' : undefined}
            className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
          >
            Assigned To
          </label>
          {caps.reassign ? (
            <Select
              value={assignedTo ?? UNASSIGNED_VALUE}
              onValueChange={(value) => {
                handleAssigneeChange(value === UNASSIGNED_VALUE ? null : value);
              }}
              disabled={updating || adminUsersLoading}
            >
              <SelectTrigger id="admin-ticket-assigned-to" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
                {/* Fallback if the ticket is assigned to an admin missing from the roster (e.g. locked after list fetch) */}
                {assignedTo !== null &&
                  !adminUsers.some((u) => u.id === assignedTo) && (
                    <SelectItem value={assignedTo}>
                      {assignedToName ?? 'Unknown admin'}
                    </SelectItem>
                  )}
                {adminUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.displayName}
                    {u.role !== 'support' ? ` (${u.role})` : ''}
                  </SelectItem>
                ))}
                {/* Ensure current admin can always self-assign even during race conditions */}
                {currentAdmin !== null && !rosterContainsCurrent && (
                  <SelectItem value={currentAdmin.id}>
                    {currentAdmin.displayName} (you)
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm text-[var(--color-fg)]">
              {assignedToName !== null ? (
                assignedToName
              ) : (
                <span className="italic text-[var(--color-muted)]">Unassigned</span>
              )}
            </p>
          )}
          {caps.selfClaim && currentAdmin !== null && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-full justify-start"
              onClick={() => {
                handleAssigneeChange(currentAdmin.id);
              }}
              disabled={updating || adminUsersLoading}
            >
              Assign to me
            </Button>
          )}
          {/*
            Take-over button, only for superadmins looking at a ticket
            currently assigned to someone else. Uses the dedicated
            /take-over endpoint (distinct from a normal reassign) so the
            audit trail records it as a privileged override rather than
            a routine hand-off.
          */}
          {caps.takeOver &&
            assignedTo !== null &&
            currentAdmin !== null &&
            assignedTo !== currentAdmin.id && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-full justify-start"
                onClick={() => {
                  setTakeOverError(null);
                  setTakeOverOpen(true);
                }}
                disabled={updating}
              >
                <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
                Take over
              </Button>
            )}
        </div>

        {/* Timestamps */}
        <div className="space-y-1 border-t border-[var(--color-border)] pt-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--color-muted)]">Created</span>
            <RelativeTime date={createdAt} className="text-[var(--color-fg)]" />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--color-muted)]">Updated</span>
            <RelativeTime date={updatedAt} className="text-[var(--color-fg)]" />
          </div>
        </div>

        {/* Quick actions, collapsed entirely for viewers who cannot
            change status. State-machine picks the buttons to render:
              open / in_progress / waiting_customer → Mark Resolved + Close
              resolved                              → Close + Reopen
              closed                                → Reopen only
            (A closed ticket can't "jump" back to resolved without first
             reopening; keeping Close+Reopen on resolved is intentional.)
        */}
        {showQuickActions && (
          <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
            <p className="text-xs font-medium text-[var(--color-muted)]">Quick Actions</p>
            {!isTerminal && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  void handleUpdate('status', 'resolved');
                }}
                disabled={updating}
              >
                <CheckCircle className="h-4 w-4 text-[var(--color-success)]" aria-hidden="true" />
                Mark as Resolved
              </Button>
            )}
            {status !== 'closed' && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  void handleUpdate('status', 'closed');
                }}
                disabled={updating}
              >
                <XCircle className="h-4 w-4 text-[var(--color-danger)]" aria-hidden="true" />
                Close Ticket
              </Button>
            )}
            {isTerminal && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  void handleUpdate('status', 'open');
                }}
                disabled={updating}
              >
                Reopen Ticket
              </Button>
            )}
          </div>
        )}
      </CardContent>

      {/*
        Reassign dialog, opened when the assignee Select transitions
        from one real admin to another. Resolves display names from the
        roster (with fallback to `assignedToName` so the old assignee's
        label never goes blank even if they were locked after the
        list was fetched).
      */}
      {reassignTargetId !== null && (
        <ReassignTicketDialog
          open={reassignTargetId !== null}
          onOpenChange={(open) => {
            if (!open && !reassignSubmitting) setReassignTargetId(null);
          }}
          currentAssigneeName={
            assignedToName ??
            adminUsers.find((u) => u.id === assignedTo)?.displayName ??
            'the current assignee'
          }
          newAssigneeName={
            adminUsers.find((u) => u.id === reassignTargetId)?.displayName ??
            (currentAdmin !== null && currentAdmin.id === reassignTargetId
              ? currentAdmin.displayName
              : 'the selected admin')
          }
          submitting={reassignSubmitting}
          error={reassignError}
          onConfirm={handleReassignConfirm}
        />
      )}

      <TakeOverTicketDialog
        open={takeOverOpen}
        onOpenChange={(open) => {
          if (!open && !takeOverSubmitting) setTakeOverOpen(false);
        }}
        currentAssigneeName={
          assignedToName ??
          adminUsers.find((u) => u.id === assignedTo)?.displayName ??
          'the current assignee'
        }
        submitting={takeOverSubmitting}
        error={takeOverError}
        onConfirm={handleTakeOverPrepare}
      />
      <DestructiveReauthModal
        open={takeOverPending !== null}
        onOpenChange={(open) => {
          if (!open && !takeOverSubmitting) setTakeOverPending(null);
        }}
        audience="admin"
        title="Confirm take-over"
        description="Re-authenticate to forcibly reassign this ticket to yourself. The override is logged in the audit trail."
        confirmLabel="Take over"
        destructive
        onConfirm={handleTakeOverReauthConfirmed}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Admin ticket detail page.
 *
 * Layout:
 * - Left column (2/3): Ticket header, full message thread (including internal
 *   notes highlighted with dashed border), and reply form with internal note toggle.
 * - Right column (1/3): Sidebar with customer info, status/priority dropdowns,
 *   assignment info, timestamps, and quick action buttons.
 */
export default function AdminTicketDetailPage() {
  const params = useParams();
  const rawId = params?.['id'];
  const ticketId = typeof rawId === 'string' ? rawId : null;
  const { detail, error, isLoading, mutate } = useAdminTicketDetail(ticketId);
  const { user: currentAdmin } = useAdminUser();
  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  // `?m=<id>` deep-link, scrolls and highlights the target message
  // when the thread finishes loading. When the query is present we
  // skip the default "scroll to bottom" effect so the two scroll
  // targets don't fight each other.
  const searchParams = useSearchParams();
  const deepLinkMessageId = (searchParams?.get('m') ?? null) ?? null;
  const messageIds = React.useMemo(
    () => detail?.messages.map((m) => m.id) ?? [],
    [detail?.messages],
  );
  const { highlightedId } = useHighlightMessageOnMount(
    deepLinkMessageId,
    detail !== null && detail !== undefined,
    messageIds,
  );

  // Auto-scroll to the latest message when there's no explicit deep-link target.
  React.useEffect(() => {
    if (deepLinkMessageId !== null && deepLinkMessageId.length > 0) return;
    if (detail?.messages && detail.messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [detail?.messages, deepLinkMessageId]);

  // Hooks must be called unconditionally before any early return.
  // BUG #58: message edits route through password+TOTP reauth, an
  // edit is evidence tampering on a logged audit thread. The child
  // ticket-message component awaits a Promise<boolean>; we resolve
  // it after the reauth modal completes so the inline edit UI
  // collapses on success or stays open on failure.
  const { execute: executeAdmin } = useAdminTicketAction();
  const [pendingMessageEdit, setPendingMessageEdit] = React.useState<{
    readonly messageId: string;
    readonly newBody: string;
    readonly resolve: (ok: boolean) => void;
  } | null>(null);

  const handleMessageEdit = React.useCallback(
    (messageId: string, newBody: string): Promise<boolean> => {
      if (ticketId === null) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        setPendingMessageEdit({ messageId, newBody, resolve });
      });
    },
    [ticketId],
  );

  const handleMessageEditReauthConfirmed = React.useCallback(
    async ({
      currentPassword,
      totpCode,
    }: { currentPassword: string; totpCode: string }): Promise<void> => {
      if (pendingMessageEdit === null || ticketId === null) return;
      const res = await executeAdmin(
        `/api/internal/admin/tickets/${ticketId}/messages/${pendingMessageEdit.messageId}`,
        {
          method: 'PATCH',
          body: { currentPassword, totpCode, body: pendingMessageEdit.newBody },
        },
      );
      if (!res.ok) {
        const responseBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = responseBody['error'] as Record<string, unknown> | undefined;
        throw new Error(
          (err?.['message'] as string | undefined) ?? 'Failed to edit message.',
        );
      }
      await mutate();
      pendingMessageEdit.resolve(true);
      setPendingMessageEdit(null);
    },
    [executeAdmin, mutate, ticketId, pendingMessageEdit],
  );

  const handleMessageEditModalChange = React.useCallback(
    (open: boolean) => {
      if (!open && pendingMessageEdit !== null) {
        // Cancel: tell child the edit failed so it returns to view mode.
        pendingMessageEdit.resolve(false);
        setPendingMessageEdit(null);
      }
    },
    [pendingMessageEdit],
  );

  if (isLoading) {
    return <AdminTicketDetailSkeleton />;
  }

  if (error || !detail) {
    const status = (error as { status?: number } | undefined)?.status;
    return (
      <div className="space-y-6">
        <Link
          href="/admin/tickets"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Tickets
        </Link>
        <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-4">
          <p className="text-sm text-[var(--color-danger)]">
            {status === 404
              ? 'Ticket not found.'
              : 'Failed to load ticket. Please try again.'}
          </p>
          {status !== 404 && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => { void mutate(); }}
            >
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  const { ticket, messages, participants, viewer } = detail;
  const isPendingInvite =
    viewer.participant !== null && viewer.participant.status === 'pending';

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/admin/tickets"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] rounded-[var(--radius-sm)]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to Tickets
      </Link>

      {/* Pending-invite banner, the caller has been invited but has not
          yet accepted. All mutation controls (reply, internal note,
          sidebar assignees) remain disabled via capabilities until they
          accept and the viewer flips to `active`. */}
      {isPendingInvite && viewer.participant !== null && (
        <PendingInviteBanner
          ticketId={ticket.id}
          inviteRole={viewer.participant.role}
          onResolved={async () => {
            await mutate();
          }}
        />
      )}

      {/* Ticket header */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-[var(--color-muted)]">
          {ticket.referenceNumber}
        </span>
        <TicketStatusBadge status={ticket.status} />
        <TicketPriorityBadge priority={ticket.priority} />
      </div>
      <h1 className="text-xl font-bold text-[var(--color-fg)]">{ticket.subject}</h1>

      {/* Two-column layout */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left column: messages + reply */}
        <div className="space-y-6 lg:col-span-2">
          {/* Messages */}
          <section aria-label="Ticket conversation" className="space-y-3">
            {messages.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--color-muted)]">
                No messages yet.
              </p>
            ) : (
              messages.map((msg) => (
                <TicketMessage
                  key={msg.id}
                  message={msg}
                  currentUserId={currentAdmin?.id ?? null}
                  onEdit={handleMessageEdit}
                  highlight={highlightedId === msg.id}
                />
              ))
            )}
            <div ref={messagesEndRef} aria-hidden="true" />
          </section>

          {/* Reply form, gated on the caller's `reply` capability.
              This covers pending invitees, non-participants viewing
              unassigned tickets (no participant row = matrix denies
              reply), and terminal-state tickets (`reply` returns
              false for resolved + closed). Superadmins bypass via
              auto-join. Showing a reply form the server would reject
              on POST would be misleading UX. */}
          {viewer.capabilities.reply ? (
            <AdminReplyForm
              ticketId={ticket.id}
              ticketStatus={ticket.status}
              onReplySent={() => {
                void mutate();
              }}
            />
          ) : (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-center">
              <p className="text-sm text-[var(--color-muted)]">
                {ticket.status === 'closed' || ticket.status === 'resolved'
                  ? 'This ticket is ' +
                    ticket.status +
                    '. Reopen it to post a reply.'
                  : isPendingInvite
                    ? 'Accept the invitation to join the conversation.'
                    : 'Claim this ticket (Assign to me) or join as a participant to post a reply.'}
              </p>
            </div>
          )}
        </div>

        {/* Right column: sidebar */}
        <div className="space-y-6">
          <TicketActionsSidebar
            ticketId={ticket.id}
            status={ticket.status}
            priority={ticket.priority}
            assignedTo={ticket.assignedTo}
            assignedToName={ticket.assignedToName}
            customerEmail={ticket.customerEmail}
            customerName={ticket.customerName}
            creator={ticket.creator}
            categoryName={ticket.categoryName}
            createdAt={ticket.createdAt}
            updatedAt={ticket.updatedAt}
            viewer={viewer}
            onUpdated={() => { void mutate(); }}
          />
          <TicketParticipantsCard
            ticketId={ticket.id}
            participants={participants}
            viewer={viewer}
            onUpdated={() => { void mutate(); }}
          />
        </div>
      </div>

      {/* BUG #58: message-edit reauth gate. Opens whenever a child
          ticket-message component awaits an edit; cancel resolves
          false so the inline editor flips back to view mode. */}
      <DestructiveReauthModal
        open={pendingMessageEdit !== null}
        onOpenChange={handleMessageEditModalChange}
        audience="admin"
        title="Confirm message edit"
        description="Re-authenticate to amend this message. Edits are logged in the audit trail with a previous-content snapshot."
        confirmLabel="Save edit"
        onConfirm={handleMessageEditReauthConfirmed}
      />
    </div>
  );
}
