/**
 * Single source of truth for the Didit decision-status → internal
 * `customer_kyc_sessions.status` mapping.
 *
 * Three consumers:
 *
 *   1. `server/handlers/didit-webhook.ts` — push channel (HTTP POST
 *      from Didit's dispatcher).
 *   2. `server/handlers/customer-kyc.ts::pullAndApplyDiditDecision` —
 *      pull-fallback that the SSE poll loop fires while the customer
 *      keeps `/kyc` open.
 *   3. `server/jobs/kyc-reconciler-worker.ts` — periodic drift sweep
 *      that catches the case where neither push nor pull landed (this
 *      module's reason for centralisation: a third caller would
 *      otherwise reintroduce the duplicate the project's "single
 *      source of truth" rule explicitly forbids).
 *
 * **Do not duplicate this map elsewhere.** If a fourth caller appears,
 * it imports from here. If Didit ships a new status, the change lands
 * here once and every caller benefits.
 *
 * The Didit V3 documented status set lives in
 * `Didit docs: 27_verification-statuses.md`
 * — the 9 strings enumerated below are the closed set. Anything else is
 * surfaced as an unknown-status branch by the calling handler (see
 * `kyc_session.webhook_unknown_status` audit action).
 */

import { DIDIT_STATUS } from './types';

/**
 * Internal `customer_kyc_sessions.status` value matching a Didit
 * decision-status string. Returns `null` for any string we don't
 * recognise — caller logs an audit-grade warning and leaves the row
 * untouched (loud signal for Didit-side schema drift).
 *
 * Mapping rationale:
 *
 *   * `Not Started`  → `pending`               (link not opened yet)
 *   * `In Progress`  → `in_progress`           (user in active flow)
 *   * `In Review`    → `in_review`             (compliance manual review)
 *   * `Resubmitted`  → `resubmission_pending`  (selective step redo)
 *   * `Approved`     → `approved`              (terminal success)
 *   * `Declined`     → `rejected`              (terminal failure)
 *   * `Expired`      → `expired`               (TTL elapsed pre-completion)
 *   * `Abandoned`    → `expired`               (user opened, didn't finish)
 *   * `Kyc Expired`  → `kyc_expired`           (post-approval expiry policy)
 *
 * Values not in the closed set return `null`. Earlier revisions also
 * mapped legacy V2 values (`Cancelled`, `Failed`) — removed so the
 * unknown-status branch stays the loud signal for any future Didit
 * value drift.
 */
export function mapDiditStatusToInternal(diditStatus: string): string | null {
  switch (diditStatus) {
    case DIDIT_STATUS.NOT_STARTED:
      return 'pending';
    case DIDIT_STATUS.IN_PROGRESS:
      return 'in_progress';
    case DIDIT_STATUS.IN_REVIEW:
      return 'in_review';
    case DIDIT_STATUS.RESUBMITTED:
      return 'resubmission_pending';
    case DIDIT_STATUS.APPROVED:
      return 'approved';
    case DIDIT_STATUS.DECLINED:
      return 'rejected';
    case DIDIT_STATUS.EXPIRED:
      return 'expired';
    case DIDIT_STATUS.ABANDONED:
      return 'expired';
    case DIDIT_STATUS.KYC_EXPIRED:
      return 'kyc_expired';
    default:
      return null;
  }
}

/**
 * Statuses where a non-webhook caller (pull-fallback, reconciler) MAY
 * overwrite the row. Bounding the UPDATE to non-terminal, non-final
 * statuses prevents a stale pull (12s after the webhook already moved
 * the row to Approved / Rejected) from clobbering authoritative state.
 *
 * `kyc_expired` and `revoked` are NOT overwritable — they carry
 * downstream side-effects (credential revoke pipeline) that pull /
 * reconciler cannot replay.
 */
export const PULL_OVERWRITABLE_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'in_review',
  'resubmission_pending',
  'identity_approved',
] as const);

export type PullOverwritableStatus = (typeof PULL_OVERWRITABLE_STATUSES)[number];

/**
 * Status strings that the reconciler treats as "terminal" — once the
 * Didit decision lands on one of these, the row should be flipped (if
 * still in an overwritable state) and no further reconciliation is
 * needed.
 */
export const RECONCILER_TERMINAL_INTERNAL_STATUSES = Object.freeze([
  'approved',
  'rejected',
  'expired',
  'kyc_expired',
] as const);

/**
 * Status strings that the reconciler treats as "still pending at
 * Didit" — the worker re-checks on the next cycle without touching the
 * DB row. Used to keep the reconciler's branching explicit.
 */
export const RECONCILER_PENDING_INTERNAL_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'in_review',
  'resubmission_pending',
] as const);
