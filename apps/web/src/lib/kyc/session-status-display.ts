/**
 * KYC session status display helpers — single source of truth.
 *
 * The 11 values in `kyc_session_status` (Postgres enum + `KycStatus`
 * union in `@crivacy/shared-types`) need consistent UI affordances
 * across at least four surfaces: the customer dashboard summary, the
 * customer `/kyc` page, the customer `/credential` page, and the admin
 * customer-detail screen. Earlier each surface kept its own ad-hoc
 * `Record<string, …>` mapping; predictably they fell out of sync —
 * admin screens still listed legacy `completed` / `failed` keys that
 * never existed in the enum, and skipped six new statuses
 * (`in_review`, `resubmission_pending`, `kyc_expired`, plus the two
 * intermediate `identity_approved` / `address_in_progress` and
 * `revoked`). This module is the canonical map every surface imports
 * from.
 *
 * **Why two label fields?** Admin sees a technical label
 * ("Resubmission Pending") that mirrors the enum value; customers see
 * an action-oriented copy ("Resubmission required") that explains
 * what happened. A single label can't serve both audiences without
 * sounding either too jargon-y for end users or too colloquial for
 * compliance reviewers.
 *
 * **Why predicate helpers?** `isActiveSessionStatus` and
 * `isStatusNeedingAttention` codify two business rules that several
 * surfaces apply ("can the user start a new session?", "should we
 * surface a banner?"). Encoding them once here means a future status
 * addition only updates one set of values, not three pages.
 */

import type { KycStatus } from '@crivacy/shared-types';

/**
 * StatusBadge variant names — kept in lock-step with
 * `components/shared/status-badge.tsx::statusBadgeVariants.status`.
 */
export type StatusVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface KycSessionStatusDisplay {
  /** Color tier for badges, banners, dots. */
  readonly variant: StatusVariant;
  /** Compact label for admin/firm dashboards (mirrors the enum value). */
  readonly adminLabel: string;
  /** Action-oriented label for customer-facing UI. */
  readonly customerLabel: string;
  /**
   * One-sentence customer-facing description. `null` for terminal
   * states where a label alone communicates everything (e.g.
   * `approved` → "Verified" needs no follow-up sentence).
   */
  readonly customerDescription: string | null;
}

/**
 * Canonical 11-status mapping. The `Record<KycStatus, …>` typing makes
 * adding a new enum value a compile error here first — the surfaces
 * that import this map then surface the same compile error wherever
 * they switch on the value. That cascade is the whole point of having
 * one map.
 */
export const KYC_SESSION_STATUS_DISPLAY: Record<KycStatus, KycSessionStatusDisplay> = {
  pending: {
    variant: 'neutral',
    adminLabel: 'Pending',
    customerLabel: 'Not started',
    customerDescription: 'Verification has not been started yet.',
  },
  in_progress: {
    variant: 'info',
    adminLabel: 'In Progress',
    customerLabel: 'In progress',
    customerDescription: 'Continue the steps in your verification flow.',
  },
  in_review: {
    variant: 'warning',
    adminLabel: 'In Review',
    customerLabel: 'Under manual review',
    customerDescription:
      'Our compliance team is reviewing your submission — typically 24-48 hours.',
  },
  identity_approved: {
    variant: 'info',
    adminLabel: 'Identity Approved',
    customerLabel: 'Identity verified',
    customerDescription: 'Identity verified — continue with address verification.',
  },
  address_in_progress: {
    variant: 'info',
    adminLabel: 'Address In Progress',
    customerLabel: 'Address verification in progress',
    customerDescription: 'Continue your address verification.',
  },
  approved: {
    variant: 'success',
    adminLabel: 'Approved',
    customerLabel: 'Verified',
    customerDescription: null,
  },
  rejected: {
    variant: 'danger',
    adminLabel: 'Rejected',
    customerLabel: 'Verification declined',
    customerDescription: 'Your submission could not be verified — contact support for next steps.',
  },
  expired: {
    variant: 'warning',
    adminLabel: 'Expired',
    customerLabel: 'Session expired',
    customerDescription: 'Your verification session timed out — start a new one to continue.',
  },
  revoked: {
    variant: 'danger',
    adminLabel: 'Revoked',
    customerLabel: 'Revoked',
    customerDescription: null,
  },
  resubmission_pending: {
    variant: 'warning',
    adminLabel: 'Resubmission Pending',
    customerLabel: 'Resubmission required',
    customerDescription: 'Some verification steps need to be redone.',
  },
  kyc_expired: {
    variant: 'danger',
    adminLabel: 'KYC Expired',
    customerLabel: 'Credential expired',
    customerDescription:
      'Your KYC credential reached its expiration date — re-verify to continue.',
  },
};

/**
 * Statuses where a session row counts as "still in flight" — i.e. the
 * customer cannot start a fresh session against the same workflow.
 *
 * `kyc_expired` is intentionally **excluded** even though its display
 * carries warning color: a re-verification flow needs a brand new
 * session, so the start CTA must remain available. Same goes for the
 * terminal failure states (`rejected`, `expired`, `revoked`) — those
 * leave the door open for a retry. `approved` is also excluded — the
 * address workflow's `approved` is terminal-final; new sessions of
 * the same workflow are blocked by the level gate, not the active
 * check.
 *
 * `identity_approved` and `address_in_progress` are intermediate
 * Didit states the worker writes between phase 1 and phase 2; from
 * the user's perspective the session is still owned by Didit and
 * starting a parallel one would race against the ongoing flow.
 *
 * Exported as the canonical list. The Set form below is the
 * predicate-friendly view; both share one source of truth so adding
 * a status only touches this array.
 */
export const ACTIVE_SESSION_STATUSES: readonly KycStatus[] = [
  'pending',
  'in_progress',
  'in_review',
  'identity_approved',
  'address_in_progress',
  'resubmission_pending',
] as const;

const ACTIVE_STATUSES: ReadonlySet<KycStatus> = new Set<KycStatus>(ACTIVE_SESSION_STATUSES);

/**
 * Statuses that the user-entity revoke pipeline should bulk-flip to
 * `revoked` when Didit signals user delete or BLOCKED. Broader than
 * `ACTIVE_SESSION_STATUSES` because we also flip the terminal
 * `approved` row — the customer's previously-successful verification
 * is no longer valid, and the bulk flip keeps downstream UI ("which
 * sessions did this customer have?") consistent with the new state.
 *
 * Excluded:
 *   - `rejected` / `expired` / `revoked` / `kyc_expired` — already
 *     terminal "no longer active" states, no observable change.
 *   - The implicit "leave a row alone if it would be a no-op" — the
 *     UPDATE's WHERE filters by these statuses so already-terminal
 *     rows simply don't match.
 */
export const REVOKABLE_SESSION_STATUSES: readonly KycStatus[] = [
  'pending',
  'in_progress',
  'in_review',
  'identity_approved',
  'address_in_progress',
  'approved',
  'resubmission_pending',
] as const;

/**
 * Statuses that warrant surfacing a banner / alert on landing pages
 * (customer dashboard, /kyc top of page). Distinct from "active" —
 * `in_progress` is active but doesn't need a callout (the stepper
 * communicates progress already), while `kyc_expired` is non-active
 * but absolutely needs a callout.
 */
const NEEDS_ATTENTION_STATUSES: ReadonlySet<KycStatus> = new Set<KycStatus>([
  'in_review',
  'resubmission_pending',
  'kyc_expired',
]);

export function isActiveSessionStatus(status: KycStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isStatusNeedingAttention(status: KycStatus): boolean {
  return NEEDS_ATTENTION_STATUSES.has(status);
}

/**
 * Return the display row for a status, falling back to a neutral
 * row that echoes the raw enum value if a future status lands in
 * the DB before this map is updated. Defensive — typing already
 * enforces exhaustiveness on direct callers, but session.status
 * arriving as `string` (over the wire) needs a runtime guard.
 */
export function resolveSessionStatusDisplay(status: string): KycSessionStatusDisplay {
  if (status in KYC_SESSION_STATUS_DISPLAY) {
    return KYC_SESSION_STATUS_DISPLAY[status as KycStatus];
  }
  return {
    variant: 'neutral',
    adminLabel: status,
    customerLabel: status,
    customerDescription: null,
  };
}
