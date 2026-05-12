/**
 * Firm-user role model — single source of truth.
 *
 * Used by:
 *   * middleware: `dashboardRoute({ minRole: 'admin' })` walks the
 *     rank ladder defined here
 *   * handlers: `validateRoleTransition` enforces invariants like
 *     "at least one owner" and "no self-demote"
 *   * validation: `firmRoleSchema` derives from `FIRM_ROLES` so
 *     adding a role is a one-line change and every layer learns
 *     about it at compile time
 *   * UI: `FIRM_ROLES` iteration drives role pickers, capability
 *     pills, and audit-log labels — no hardcoded strings in React
 *
 * Rules we encode (industry standard, cf. Stripe / Vercel / GitHub):
 *   * owner > admin > member > viewer (strict rank order)
 *   * An actor can only manage roles ≤ their own rank (no privilege
 *     escalation via invite or role change).
 *   * A firm must have at least one owner at all times. Demoting the
 *     last owner is blocked with a typed error the UI can render.
 *   * An actor cannot demote themselves (prevents owner locking out
 *     their own account). Promote-self is also blocked for symmetry.
 *   * Every action is gated via a capability key, not by checking
 *     role strings in feature code. Adding a new capability touches
 *     exactly this file and its consumers.
 *
 * This module is PURE — no DB, no network. The "how many owners are
 * left?" input comes from the caller (handler / repository) so the
 * engine stays stateless and easy to test.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Role metadata
// ---------------------------------------------------------------------------

/**
 * Ordered list of firm roles, highest rank first. `rank` is the
 * monotonically-decreasing privilege level used by `canManageRole`.
 * Labels and descriptions are consumed by UI role pickers so the
 * dashboard never needs to hardcode "Owner" / "Admin" text.
 */
export const FIRM_ROLES = [
  {
    id: 'owner',
    rank: 3,
    label: 'Owner',
    description: 'Full access including billing and team management.',
  },
  {
    id: 'admin',
    rank: 2,
    label: 'Admin',
    description: 'Manage API keys, webhooks, and teammates.',
  },
  {
    id: 'member',
    rank: 1,
    label: 'Member',
    description: 'Use API keys and inspect usage. Cannot manage the team.',
  },
  {
    id: 'viewer',
    rank: 0,
    label: 'Viewer',
    description: 'Read-only access for auditors and external reviewers.',
  },
] as const;

export type FirmRole = (typeof FIRM_ROLES)[number]['id'];

const ROLE_RANK: Readonly<Record<FirmRole, number>> = Object.freeze(
  Object.fromEntries(FIRM_ROLES.map((r) => [r.id, r.rank])) as Record<FirmRole, number>,
);

/** `true` when the argument is a declared firm role id. */
export function isFirmRole(value: string): value is FirmRole {
  return (FIRM_ROLES as readonly { id: string }[]).some((r) => r.id === value);
}

/** Integer rank for the given role. `-1` for unknown inputs (defensive). */
export function rankOf(role: string): number {
  return isFirmRole(role) ? ROLE_RANK[role] : -1;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Capability → minimum rank that carries it. The minRole approach
 * matches our existing `dashboardRoute` middleware — new routes can
 * declare `minRole: CAP.manageTeam` and stay policy-driven without
 * duplicating rank literals.
 */
export const FIRM_CAPABILITIES = {
  manageBilling: 'owner',
  manageTeam: 'admin',
  manageApiKeys: 'admin',
  manageWebhooks: 'admin',
  openTicket: 'viewer',
  viewUsage: 'viewer',
  viewAuditLog: 'member',
  viewApiKeys: 'member',
  viewWebhooks: 'member',
} as const satisfies Record<string, FirmRole>;

export type FirmCapability = keyof typeof FIRM_CAPABILITIES;

/**
 * `true` when the actor's role satisfies the capability's minimum
 * rank. Unknown caller roles always fail closed.
 */
export function hasCapability(role: string, capability: FirmCapability): boolean {
  const actorRank = rankOf(role);
  if (actorRank < 0) return false;
  return actorRank >= ROLE_RANK[FIRM_CAPABILITIES[capability]];
}

/**
 * Bulk capability snapshot for a given role — useful for surfacing
 * pre-computed flags in API responses so the UI can hide/disable
 * controls without reimplementing the policy matrix client-side.
 */
export function capabilitiesFor(role: string): Readonly<Record<FirmCapability, boolean>> {
  const out = {} as Record<FirmCapability, boolean>;
  for (const cap of Object.keys(FIRM_CAPABILITIES) as FirmCapability[]) {
    out[cap] = hasCapability(role, cap);
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Role management invariants
// ---------------------------------------------------------------------------

/**
 * `true` when `actor` outranks `target` strictly (can promote /
 * demote them). Equal rank is NOT outranking — admins cannot change
 * other admins' roles, for example, even laterally.
 */
export function canManageRole(actor: string, target: string): boolean {
  const a = rankOf(actor);
  const t = rankOf(target);
  if (a < 0 || t < 0) return false;
  return a > t;
}

/**
 * `true` when `actor` is permitted to assign the given role to a
 * new or existing teammate. Actors cannot assign roles equal to or
 * above their own — otherwise an admin could invite an owner and
 * bypass the owner-count invariant.
 */
export function canAssignRole(actor: string, targetRole: string): boolean {
  const a = rankOf(actor);
  const t = rankOf(targetRole);
  if (a < 0 || t < 0) return false;
  return a > t;
}

/** Typed result type for {@link validateRoleTransition}. */
export type RoleTransitionIssue =
  | 'unknown_role'
  | 'self_change_forbidden'
  | 'target_outranks_actor'
  | 'target_role_not_manageable_by_actor'
  | 'owner_invariant_violated';

export interface RoleTransitionResult {
  readonly ok: boolean;
  readonly code?: RoleTransitionIssue;
  readonly message?: string;
}

/**
 * Evaluate a role change against every invariant the firm model
 * relies on. The caller (handler) passes in the post-transition
 * owner count so the engine stays stateless.
 *
 * Invariants (in check order):
 *   1. Both `from` and `to` must be declared firm roles.
 *   2. Actors cannot change their own role (promote OR demote — the
 *      latter would self-lock; the former would be self-privilege-
 *      escalation).
 *   3. Actor must outrank the target's CURRENT role (you cannot
 *      touch a peer or someone senior).
 *   4. Actor must be able to assign the NEW role — no privilege
 *      escalation through role changes (admin cannot promote a
 *      member to owner, for instance).
 *   5. The firm must end up with ≥ 1 owner. The caller computes the
 *      post-transition owner count and passes it in; the engine
 *      simply checks the floor.
 */
export function validateRoleTransition(args: {
  readonly actor: string;
  readonly targetCurrent: string;
  readonly targetNew: string;
  readonly isSelf: boolean;
  readonly ownerCountAfter: number;
}): RoleTransitionResult {
  if (!isFirmRole(args.targetCurrent) || !isFirmRole(args.targetNew) || !isFirmRole(args.actor)) {
    return {
      ok: false,
      code: 'unknown_role',
      message: 'One of the role values is not recognised.',
    };
  }

  if (args.isSelf) {
    return {
      ok: false,
      code: 'self_change_forbidden',
      message: 'You cannot change your own role.',
    };
  }

  if (!canManageRole(args.actor, args.targetCurrent)) {
    return {
      ok: false,
      code: 'target_outranks_actor',
      message: 'You cannot change the role of a teammate at or above your own rank.',
    };
  }

  if (!canAssignRole(args.actor, args.targetNew)) {
    return {
      ok: false,
      code: 'target_role_not_manageable_by_actor',
      message: 'You cannot assign a role equal to or above your own.',
    };
  }

  if (args.ownerCountAfter < 1) {
    return {
      ok: false,
      code: 'owner_invariant_violated',
      message: 'A firm must have at least one owner.',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Invite-specific invariants (new firm_user)
// ---------------------------------------------------------------------------

export type InviteIssue =
  | 'unknown_role'
  | 'capability_denied'
  | 'target_role_not_manageable_by_actor';

export interface InviteValidationResult {
  readonly ok: boolean;
  readonly code?: InviteIssue;
  readonly message?: string;
}

/**
 * Validate an invite-new-user request. No owner-count check is
 * needed here — inviting a member / admin / viewer never touches
 * the owner count, and inviting a second owner is legal (it
 * increases the count, which only helps).
 */
export function validateInviteRole(args: {
  readonly actor: string;
  readonly targetRole: string;
}): InviteValidationResult {
  if (!isFirmRole(args.actor) || !isFirmRole(args.targetRole)) {
    return {
      ok: false,
      code: 'unknown_role',
      message: 'One of the role values is not recognised.',
    };
  }

  if (!hasCapability(args.actor, 'manageTeam')) {
    return {
      ok: false,
      code: 'capability_denied',
      message: 'You do not have permission to invite teammates.',
    };
  }

  if (!canAssignRole(args.actor, args.targetRole)) {
    return {
      ok: false,
      code: 'target_role_not_manageable_by_actor',
      message: 'You cannot invite a teammate at or above your own rank.',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Remove-specific invariants
// ---------------------------------------------------------------------------

export type RemoveIssue =
  | 'self_change_forbidden'
  | 'target_outranks_actor'
  | 'owner_invariant_violated';

export interface RemoveValidationResult {
  readonly ok: boolean;
  readonly code?: RemoveIssue;
  readonly message?: string;
}

/**
 * Validate removing (deactivating) a teammate. Same privilege rules
 * as role change apply — plus the owner-count invariant when the
 * removed user is an owner.
 */
export function validateRemove(args: {
  readonly actor: string;
  readonly targetRole: string;
  readonly isSelf: boolean;
  readonly ownerCountAfter: number;
}): RemoveValidationResult {
  if (args.isSelf) {
    return {
      ok: false,
      code: 'self_change_forbidden',
      message: 'You cannot remove yourself. Ask another owner or admin.',
    };
  }

  if (!canManageRole(args.actor, args.targetRole)) {
    return {
      ok: false,
      code: 'target_outranks_actor',
      message: 'You cannot remove a teammate at or above your own rank.',
    };
  }

  if (args.targetRole === 'owner' && args.ownerCountAfter < 1) {
    return {
      ok: false,
      code: 'owner_invariant_violated',
      message: 'A firm must have at least one owner.',
    };
  }

  return { ok: true };
}
