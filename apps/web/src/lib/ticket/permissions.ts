/**
 * Ticket permission matrix and role hierarchy helpers.
 *
 * Centralises the "who can do what on a ticket" logic so handlers stay
 * thin and auditors can review the rules in one file. Every admin
 * ticket handler should route its authorization decision through
 * {@link canPerformTicketAction}.
 *
 * Role hierarchy (ordinal):
 *   support(0) < admin(1) < superadmin(2)
 *
 * Rule of thumb:
 *   * `superadmin` bypasses participant checks entirely -- they can
 *     read, reply to, and administer any ticket.
 *   * `admin` / `support` must be an active participant (`assignee` or
 *     `collaborator`) to interact. Non-participants see unassigned
 *     tickets only (the pickup pool) and cannot mutate them without
 *     first taking ownership.
 *   * Only the `assignee` participant (or `superadmin`) can change
 *     ticket state: status, priority, assignment, invite/remove
 *     participants.
 *
 * These rules mirror the locked decisions for Faz 1 of the
 * multi-participant ticket redesign. Invite/accept/decline and
 * take-over flows are implemented in later phases and build on top of
 * this matrix.
 *
 * @module
 */

import type { ResolvedAdminUser } from '@/server/context';

// ---------------------------------------------------------------------------
// Role hierarchy
// ---------------------------------------------------------------------------

export type AdminRole = ResolvedAdminUser['role'];

/** Ordinal rank -- higher number = more privilege. */
export const ROLE_RANK: Record<AdminRole, number> = Object.freeze({
  support: 0,
  admin: 1,
  superadmin: 2,
});

/**
 * `true` when `a` outranks `b` in the admin hierarchy. Equal rank is
 * NOT outranking -- use this for "can downgrade" / "can direct-add"
 * checks where strict dominance matters.
 */
export function outranks(a: AdminRole, b: AdminRole): boolean {
  return ROLE_RANK[a] > ROLE_RANK[b];
}

/** `true` when `a` is at or above `b` in the admin hierarchy. */
export function atLeast(a: AdminRole, b: AdminRole): boolean {
  return ROLE_RANK[a] >= ROLE_RANK[b];
}

// ---------------------------------------------------------------------------
// Participant shape (subset used by the matrix)
// ---------------------------------------------------------------------------

/**
 * The minimum participant fields the permission matrix needs. Handlers
 * pass `null` when the caller has no row on the ticket.
 */
export interface ParticipantRef {
  readonly role: 'assignee' | 'collaborator';
  readonly status: 'pending' | 'active' | 'declined' | 'removed';
}

/** `true` when the row exists and is currently active. */
export function isActiveParticipant(p: ParticipantRef | null): boolean {
  return p !== null && p.status === 'active';
}

/** `true` when the row is the active assignee (single-owner). */
export function isActiveAssignee(p: ParticipantRef | null): boolean {
  return p !== null && p.status === 'active' && p.role === 'assignee';
}

/**
 * `true` when the caller has an outstanding invitation (pending row)
 * that has not yet been accepted, declined, or expired out. Pending
 * invitees may READ the ticket (so they can decide) but may not mutate
 * it — the action matrix enforces that distinction per-action.
 */
export function isPendingInvitee(p: ParticipantRef | null): boolean {
  return p !== null && p.status === 'pending';
}

// ---------------------------------------------------------------------------
// Ticket context for permission checks
// ---------------------------------------------------------------------------

/**
 * Snapshot of the ticket state needed by {@link canPerformTicketAction}.
 * The handler builds this from the DB row -- the permission module
 * never queries Postgres itself.
 */
export interface TicketPermissionContext {
  /** `tickets.assigned_to` -- null when the ticket is in the pickup pool. */
  readonly assignedTo: string | null;
  /** Terminal-state tickets reject most mutations. */
  readonly status:
    | 'open'
    | 'in_progress'
    | 'waiting_customer'
    | 'resolved'
    | 'closed';
}

// ---------------------------------------------------------------------------
// Action matrix
// ---------------------------------------------------------------------------

/**
 * Every authorized operation an admin can attempt against a ticket.
 * Keep this union exhaustive -- new actions must extend both the type
 * and {@link canPerformTicketAction}.
 */
export type TicketAction =
  | 'read'
  | 'reply'
  | 'internal_note'
  | 'change_status'
  | 'change_priority'
  | 'reassign'
  | 'invite_participant'
  | 'add_participant'
  | 'remove_participant'
  | 'take_over';

/**
 * Decide whether `user` may perform `action` on a ticket, given their
 * participant row (or `null` when they have none).
 *
 * The caller is responsible for:
 *   * Resolving the participant row via {@link getParticipantRef}.
 *   * Returning a 403 on `false` and a 404 on "invisible" tickets
 *     (use {@link canReadTicket} for visibility gating).
 *   * Subsequent business-logic checks the matrix does not cover
 *     (e.g. "cannot invite an admin that outranks you").
 */
export function canPerformTicketAction(
  user: Pick<ResolvedAdminUser, 'role'>,
  participant: ParticipantRef | null,
  action: TicketAction,
  ticket: TicketPermissionContext,
): boolean {
  const isSuperadmin = user.role === 'superadmin';
  const isAssignee = isActiveAssignee(participant);
  const isActive = isActiveParticipant(participant);
  const isPending = isPendingInvitee(participant);
  const isUnassigned = ticket.assignedTo === null;
  const isTerminal = ticket.status === 'resolved' || ticket.status === 'closed';

  switch (action) {
    case 'read':
      // Superadmin sees everything. Active participants see their
      // tickets. Pending invitees can read so they have context to
      // accept or decline the invitation (the handler strips
      // internal notes from their response). Non-participants see
      // unassigned tickets only (pickup pool) -- this keeps the pool
      // discoverable without leaking assigned tickets across teams.
      if (isSuperadmin) return true;
      if (isActive) return true;
      if (isPending) return true;
      return isUnassigned;

    case 'reply':
    case 'internal_note':
      // Message posting. Superadmin can always reply (auto-joins as
      // collaborator elsewhere). Active participants can reply.
      // Terminal-state tickets accept no new messages.
      if (isTerminal) return false;
      return isSuperadmin || isActive;

    case 'change_status':
    case 'change_priority':
      // Single-owner mutations. Only the assignee (or superadmin) may
      // alter ticket state. Collaborators are read+reply only on these
      // fields by design -- otherwise two admins can fight over state.
      return isSuperadmin || isAssignee;

    case 'reassign':
      // Reassignment follows the same rule as state mutation.
      // Downgrade-to-lower-level and "stay as collab" are business
      // rules enforced in the handler, not here.
      return isSuperadmin || isAssignee;

    case 'invite_participant':
    case 'add_participant':
    case 'remove_participant':
      // Participant-graph edits are assignee-only (plus superadmin).
      // Collaborators cannot invite new people or kick each other --
      // that responsibility lives with the owner.
      return isSuperadmin || isAssignee;

    case 'take_over':
      // Superadmin-only escape hatch for stuck tickets. The handler
      // additionally enforces that the take-over either displaces a
      // lower-tier assignee or claims an unassigned ticket.
      return isSuperadmin;

    default: {
      // Exhaustiveness guard -- if a new action is added above without
      // a case here, TypeScript fails the build.
      const _exhaustive: never = action;
      void _exhaustive;
      return false;
    }
  }
}
