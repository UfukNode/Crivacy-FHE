'use client';

/**
 * Admin ticket detail, Participants card.
 *
 * Surfaces the ticket's participant graph (assignee + collaborators) with
 * inline controls for self-leave, remove, accept/decline pending invites,
 * and an invite flow launched from the card header. The server is still
 * the source of truth for every permission check; the
 * `viewer.capabilities` object piggy-backed on the ticket detail response
 * is advisory only and is used purely to hide buttons the current admin
 * could never use.
 *
 * Participants whose `status` is `declined` or `removed` are filtered out;
 * we only display the active collaboration graph plus outstanding pending
 * invites so the card stays focused on who can currently act on the ticket.
 *
 * @module
 */

import * as React from 'react';
import {
  Check,
  LogOut,
  UserMinus,
  UserPlus,
  VolumeX,
  X as XIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { LoadingButton } from '@/components/shared/loading-button';
import { UserAvatar } from '@/components/shared/user-avatar';
import {
  useAdminTicketAction,
  useAdminUsers,
} from '@/hooks/use-admin-tickets';
import { useAdminUser } from '@/hooks/use-admin-user';
import type {
  AdminTicketParticipant,
  AdminTicketViewer,
  AdminUserOption,
} from '@/hooks/use-admin-tickets';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Matches the server-side role hierarchy in `lib/ticket/permissions.ts`
 * so the invite picker hides candidates the caller cannot invite. The
 * server still rejects out-of-range targets; this is UX polish only.
 */
const ROLE_RANK = {
  support: 0,
  admin: 1,
  superadmin: 2,
} as const satisfies Record<AdminUserOption['role'] & string, number>;

type AdminRole = keyof typeof ROLE_RANK;

function isAdminRole(role: string): role is AdminRole {
  return role === 'superadmin' || role === 'admin' || role === 'support';
}

const INVITE_MESSAGE_MAX = 500;

/**
 * Human-friendly label for an admin's platform role. Keeps the wording
 * consistent with the role badge on the ticket assignee dropdown.
 */
function adminRoleLabel(role: AdminTicketParticipant['adminRole']): string {
  switch (role) {
    case 'superadmin':
      return 'Superadmin';
    case 'admin':
      return 'Admin';
    case 'support':
      return 'Support';
  }
}

/**
 * Extract the server error message from a failed JSON response, falling
 * back to the provided default. Keeps the call sites small and reduces
 * the risk of mis-typing the `error.message` path.
 */
async function readErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body['error'] as Record<string, unknown> | undefined;
  return (err?.['message'] as string | undefined) ?? fallback;
}

// ---------------------------------------------------------------------------
// Participant row
// ---------------------------------------------------------------------------

type ParticipantActionMode = 'leave' | 'remove' | 'rescind';

interface ParticipantRowProps {
  readonly participant: AdminTicketParticipant;
  readonly isSelf: boolean;
  readonly canRemoveOthers: boolean;
  readonly viewerRole: 'superadmin' | 'admin' | 'support';
  readonly pending: boolean;
  readonly onAction: (participant: AdminTicketParticipant, mode: ParticipantActionMode) => void;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
  readonly actionLoading: boolean;
}

function ParticipantRow({
  participant,
  isSelf,
  canRemoveOthers,
  viewerRole,
  pending,
  onAction,
  onAccept,
  onDecline,
  actionLoading,
}: ParticipantRowProps) {
  // The current viewer has a pending invite on this ticket. Accept/Decline
  // supersede leave/remove because you cannot leave something you haven't
  // joined, and the invitee is the only one allowed to act on the invite.
  const isSelfInvitee = isSelf && pending;

  // Self-leave is only meaningful for active collaborators. The assignee
  // cannot "leave" -- they reassign instead, which is handled in a later
  // piece via the dedicated reassign modal.
  const canLeave =
    !isSelfInvitee &&
    isSelf &&
    participant.role === 'collaborator' &&
    participant.status === 'active';

  // Only the assignee (or a superadmin) may remove other participants; the
  // server enforces this regardless, but we avoid rendering a button that
  // would always return 403. The DELETE handler accepts both `active` and
  // `pending` rows -- pending rescind is conceptually "cancel invite" and
  // surfaces with a different label so the action is unambiguous.
  //
  // Hierarchy guard (mirror of `handleRemoveParticipant` line 2861): a
  // non-superadmin cannot remove a participant ranked above them. Without
  // this the UI renders a button that always 403s -- misleading at best,
  // and visually implies a permission the caller doesn't have.
  const outranksViewer =
    viewerRole !== 'superadmin' &&
    ROLE_RANK[participant.adminRole] > ROLE_RANK[viewerRole];
  const canRemove =
    !isSelf && canRemoveOthers && !outranksViewer && participant.status === 'active';
  const canRescindPending =
    !isSelf && canRemoveOthers && !outranksViewer && participant.status === 'pending';

  // Row-level hierarchy (Option A): a thicker left edge + tinted
  // background makes assignee vs collab vs pending readable at a
  // glance without leaning on badge color alone. The badge itself is
  // still rendered so screen readers and color-blind viewers have a
  // textual label.
  const rowTone =
    participant.status === 'pending'
      ? 'border-l-[3px] border-l-[var(--color-warning)] bg-[var(--color-warning)]/[0.06]'
      : participant.role === 'assignee'
        ? 'border-l-[3px] border-l-[var(--color-accent)] bg-[var(--color-accent)]/[0.06]'
        : 'bg-[var(--color-surface)]';

  // Collaborator badge gets a muted-but-solid treatment so it has
  // equal visual weight to "Assignee" (accent) and "Pending"
  // (warning) rather than blending into the row background like the
  // default `secondary` variant does on dark themes.
  const collabBadgeClass =
    'shrink-0 border-transparent bg-[var(--color-muted)]/15 px-1.5 py-0 text-[10px] leading-4 text-[var(--color-fg)]';

  return (
    <li
      className={`flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-2 ${rowTone}`}
    >
      <UserAvatar
        user={{ id: participant.adminUserId, displayName: participant.displayName }}
        size="sm"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-medium text-[var(--color-fg)]">
            {participant.displayName}
            {isSelf && (
              <span className="ml-1 text-xs font-normal text-[var(--color-muted)]">
                (you)
              </span>
            )}
          </p>
          {pending ? (
            // Pending invitees show only the "Pending" badge. Their role
            // (assignee/collab) reflects the FUTURE state if they accept,
            // not the current one, showing both labels on a narrow card
            // forces a wrap and duplicates intent.
            <Badge variant="warning" className="shrink-0 px-1.5 py-0 text-[10px] leading-4">
              Pending
            </Badge>
          ) : participant.role === 'assignee' ? (
            <Badge variant="default" className="shrink-0 px-1.5 py-0 text-[10px] leading-4">
              Assignee
            </Badge>
          ) : (
            <Badge variant="secondary" className={collabBadgeClass}>
              Collaborator
            </Badge>
          )}
          {participant.muted && (
            <VolumeX
              className="h-3 w-3 shrink-0 text-[var(--color-muted)]"
              aria-label="Notifications muted"
            />
          )}
        </div>
        <p className="truncate text-xs text-[var(--color-muted)]">
          {adminRoleLabel(participant.adminRole)} · {participant.email}
        </p>
      </div>
      {isSelfInvitee ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="default"
            size="sm"
            onClick={onAccept}
            disabled={actionLoading}
            aria-label="Accept invite"
            title="Accept invite"
            className="h-8 px-2"
          >
            <Check className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDecline}
            disabled={actionLoading}
            aria-label="Decline invite"
            title="Decline invite"
            className="h-8 px-2"
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        (canLeave || canRemove || canRescindPending) && (
          <div className="flex shrink-0 items-center">
            {canLeave && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { onAction(participant, 'leave'); }}
                aria-label="Leave this ticket"
                title="Leave this ticket"
                className="h-8 px-2"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
            {canRemove && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { onAction(participant, 'remove'); }}
                aria-label={`Remove ${participant.displayName}`}
                title={`Remove ${participant.displayName}`}
                className="h-8 px-2"
              >
                <UserMinus className="h-4 w-4 text-[var(--color-danger)]" aria-hidden="true" />
              </Button>
            )}
            {canRescindPending && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { onAction(participant, 'rescind'); }}
                aria-label={`Cancel invite to ${participant.displayName}`}
                title={`Cancel invite to ${participant.displayName}`}
                className="h-8 px-2"
              >
                <XIcon className="h-4 w-4 text-[var(--color-danger)]" aria-hidden="true" />
              </Button>
            )}
          </div>
        )
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Invite dialog
// ---------------------------------------------------------------------------

interface InviteParticipantDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly ticketId: string;
  readonly candidates: readonly AdminUserOption[];
  readonly onInvited: () => void;
}

function InviteParticipantDialog({
  open,
  onOpenChange,
  ticketId,
  candidates,
  onInvited,
}: InviteParticipantDialogProps) {
  const { execute } = useAdminTicketAction();
  const [selectedId, setSelectedId] = React.useState<string>('');
  const [message, setMessage] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset state every time the dialog is opened so a previous attempt
  // doesn't leak into the next one (e.g. a stale error, or a selection
  // that's no longer in the candidate list after `mutate()`).
  React.useEffect(() => {
    if (open) {
      setSelectedId('');
      setMessage('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const selected = candidates.find((c) => c.id === selectedId);

  async function handleSubmit(): Promise<void> {
    if (selectedId === '') {
      setError('Please pick an admin to invite.');
      return;
    }

    const trimmed = message.trim();
    if (trimmed.length > INVITE_MESSAGE_MAX) {
      setError(`Message must be at most ${INVITE_MESSAGE_MAX} characters.`);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await execute(
        `/api/internal/admin/tickets/${ticketId}/participants`,
        {
          method: 'POST',
          body: {
            adminUserId: selectedId,
            ...(trimmed.length > 0 ? { message: trimmed } : {}),
          },
        },
      );
      if (!res.ok) {
        setError(await readErrorMessage(res, 'Failed to send invite.'));
        return;
      }
      onInvited();
      onOpenChange(false);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const noCandidates = candidates.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite participant</DialogTitle>
          <DialogDescription>
            Peers (same role) get a pending invite they can accept or decline.
            Lower-ranked admins are added directly.
          </DialogDescription>
        </DialogHeader>

        {error !== null && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {noCandidates ? (
          <p className="text-sm text-[var(--color-muted)]">
            No eligible admins available to invite. Everyone on the roster is
            already a participant, ranked above you, or locked.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="invite-admin-select"
                className="text-xs font-medium text-[var(--color-muted)]"
              >
                Admin
              </label>
              <Select
                value={selectedId}
                onValueChange={(value) => { setSelectedId(value); }}
                disabled={submitting}
              >
                <SelectTrigger id="invite-admin-select" className="w-full">
                  <SelectValue placeholder="Pick an admin..." />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.displayName}
                      {c.role !== 'support' ? ` (${c.role})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selected !== undefined && (
                <p className="text-xs text-[var(--color-muted)]">
                  {selected.email}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="invite-admin-message"
                className="text-xs font-medium text-[var(--color-muted)]"
              >
                Message (optional)
              </label>
              <Textarea
                id="invite-admin-message"
                value={message}
                onChange={(e) => { setMessage(e.target.value); }}
                maxLength={INVITE_MESSAGE_MAX}
                rows={3}
                placeholder="Short note shown to the invitee..."
                disabled={submitting}
              />
              <p className="text-right text-xs text-[var(--color-muted)]">
                {message.length}/{INVITE_MESSAGE_MAX}
              </p>
            </div>
          </div>
        )}

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
            disabled={noCandidates || selectedId === ''}
            onClick={() => { void handleSubmit(); }}
          >
            Send invite
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Participants card
// ---------------------------------------------------------------------------

export interface TicketParticipantsCardProps {
  readonly ticketId: string;
  readonly participants: readonly AdminTicketParticipant[];
  readonly viewer: AdminTicketViewer;
  readonly onUpdated: () => void;
}

interface PendingAction {
  readonly participant: AdminTicketParticipant;
  readonly mode: ParticipantActionMode;
}

/**
 * Renders the ticket's active + pending participants plus inline self-leave,
 * remove, accept/decline, and an invite entry point. Destructive actions
 * funnel through a single `ConfirmDialog` to keep the behavior explicit.
 */
export function TicketParticipantsCard({
  ticketId,
  participants,
  viewer,
  onUpdated,
}: TicketParticipantsCardProps) {
  const { execute } = useAdminTicketAction();
  const { user: currentAdmin } = useAdminUser();
  const { users: adminRoster } = useAdminUsers();
  const [pending, setPending] = React.useState<PendingAction | null>(null);
  // `submitting` previously gated the legacy ConfirmDialog; the
  // reauth modal owns its own loading state now. `error` is kept
  // for the invite-respond (accept/decline) flow which surfaces
  // failures inline at the top of the card.
  const [inviteResponding, setInviteResponding] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // `declined` and `removed` rows stay in the DB for audit purposes but are
  // no longer collaborating on the ticket, so we hide them from the UI.
  const visible = React.useMemo(
    () =>
      participants
        .filter((p) => p.status === 'active' || p.status === 'pending')
        .slice()
        .sort((a, b) => {
          // Assignee first, then by invitedAt ascending so the graph reads
          // in the order people joined.
          if (a.role !== b.role) {
            return a.role === 'assignee' ? -1 : 1;
          }
          return a.invitedAt.localeCompare(b.invitedAt);
        }),
    [participants],
  );

  // Admins the caller can realistically invite: exclude self, exclude anyone
  // already active/pending on the ticket, and exclude anyone strictly
  // ranked above the caller (unless the caller is a superadmin).
  const inviteCandidates = React.useMemo<readonly AdminUserOption[]>(() => {
    if (currentAdmin === null) return [];
    if (!isAdminRole(currentAdmin.role)) return [];

    const callerRank = ROLE_RANK[currentAdmin.role];
    const isSuperadmin = currentAdmin.role === 'superadmin';

    const activeOrPending = new Set(
      participants
        .filter((p) => p.status === 'active' || p.status === 'pending')
        .map((p) => p.adminUserId),
    );

    return adminRoster.filter((admin) => {
      if (admin.id === currentAdmin.id) return false;
      if (activeOrPending.has(admin.id)) return false;
      if (!isAdminRole(admin.role)) return false;
      if (isSuperadmin) return true;
      return ROLE_RANK[admin.role] <= callerRank;
    });
  }, [adminRoster, currentAdmin, participants]);

  function requestAction(
    participant: AdminTicketParticipant,
    mode: ParticipantActionMode,
  ): void {
    setError(null);
    setPending({ participant, mode });
  }

  // BUG #58: participant DELETE is the lone-admin attack surface
  // (stolen-session attacker kicks every collaborator). Reauth is
  // required for self-leave AND remove-other AND rescind-invite,
  // all three modes share this DELETE endpoint.
  async function handleConfirmReauthed({
    currentPassword,
    totpCode,
  }: { currentPassword: string; totpCode: string }): Promise<void> {
    if (pending === null) return;
    const res = await execute(
      `/api/internal/admin/tickets/${ticketId}/participants/${pending.participant.adminUserId}`,
      { method: 'DELETE', body: { currentPassword, totpCode } },
    );
    if (!res.ok) {
      const fallback: Record<ParticipantActionMode, string> = {
        leave: 'Failed to leave ticket.',
        remove: 'Failed to remove participant.',
        rescind: 'Failed to cancel invite.',
      };
      throw new Error(await readErrorMessage(res, fallback[pending.mode]));
    }
    setPending(null);
    onUpdated();
  }

  async function respondToInvite(action: 'accept' | 'decline'): Promise<void> {
    setInviteResponding(true);
    setError(null);
    try {
      const res = await execute(
        `/api/internal/admin/tickets/${ticketId}/participants/${action}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        setError(
          await readErrorMessage(
            res,
            action === 'accept'
              ? 'Failed to accept invite.'
              : 'Failed to decline invite.',
          ),
        );
        return;
      }
      onUpdated();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setInviteResponding(false);
    }
  }

  const canRemoveOthers = viewer.capabilities.removeParticipant;
  // Both `invite_participant` and `add_participant` share the same server
  // permission check; surfacing either is equivalent for the "show the
  // invite button" decision.
  const canInvite =
    viewer.capabilities.invite || viewer.capabilities.addParticipant;

  const confirmTitle =
    pending === null
      ? ''
      : pending.mode === 'leave'
        ? 'Leave this ticket?'
        : pending.mode === 'rescind'
          ? 'Cancel this invite?'
          : 'Remove participant?';
  const confirmDescription =
    pending === null
      ? ''
      : pending.mode === 'leave'
        ? 'You will stop receiving notifications for this ticket and can no longer reply. The assignee can re-invite you later.'
        : pending.mode === 'rescind'
          ? `${pending.participant.displayName}'s pending invite will be withdrawn. They will be notified that the invite was cancelled. This action is logged in the audit trail.`
          : `${pending.participant.displayName} will be removed from this ticket and will stop receiving notifications. This action is logged in the audit trail.`;
  const confirmLabel =
    pending === null
      ? ''
      : pending.mode === 'leave'
        ? 'Leave'
        : pending.mode === 'rescind'
          ? 'Cancel invite'
          : 'Remove';

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm">Participants</CardTitle>
        {canInvite && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setInviteOpen(true); }}
            aria-label="Invite participant"
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            Invite
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {error !== null && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2 py-1 text-xs text-[var(--color-danger)]">
            {error}
          </div>
        )}
        {visible.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No participants yet. The ticket is unassigned.
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((participant) => (
              <ParticipantRow
                key={participant.adminUserId}
                participant={participant}
                isSelf={
                  currentAdmin !== null && currentAdmin.id === participant.adminUserId
                }
                canRemoveOthers={canRemoveOthers}
                viewerRole={viewer.role}
                pending={participant.status === 'pending'}
                onAction={requestAction}
                onAccept={() => { void respondToInvite('accept'); }}
                onDecline={() => { void respondToInvite('decline'); }}
                actionLoading={inviteResponding}
              />
            ))}
          </ul>
        )}
      </CardContent>
      <DestructiveReauthModal
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        audience="admin"
        title={confirmTitle}
        description={confirmDescription}
        confirmLabel={confirmLabel}
        destructive
        onConfirm={handleConfirmReauthed}
      />
      <InviteParticipantDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        ticketId={ticketId}
        candidates={inviteCandidates}
        onInvited={onUpdated}
      />
    </Card>
  );
}
