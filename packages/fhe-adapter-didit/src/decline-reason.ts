/**
 * Decline-reason resolver — given a flat list of `DiditWarningEntry`
 * surfaced from `hydrateDecisionResponse`, picks the highest-priority
 * warning per `DIDIT_DECLINE_REASON_PRIORITY` and returns its code +
 * a human-readable short description.
 *
 * Single source of truth for the priority order — every consumer
 * (hydrate projection, customer dashboard `failure_reason` column,
 * `/kyc/callback` page status copy, firm webhook `reason` field)
 * reads the result of this resolver. No inline priority lists
 * anywhere else.
 *
 * Behaviour contract:
 *   - Empty / non-error warnings → `(null, null)` (session-level
 *     decline without a specific feature warning, e.g. workflow
 *     misconfigured). Caller falls back to a generic message.
 *   - Unknown risk code (Didit ships new codes between versions) →
 *     not the highest priority; caller still sees a known one if any
 *     fired. If ONLY unknown codes fired, the resolver returns the
 *     first one seen as a tail-fallback (so the operator at least has
 *     SOMETHING to grep, even though the priority rank is unstable).
 *   - Information-level warnings (`log_type === 'information'`) are
 *     ignored entirely — they are not decline reasons. Notably
 *     `DUPLICATED_IP_ADDRESS` is info-level and never surfaces.
 */

import {
  DIDIT_DECLINE_REASON_PRIORITY,
  type DiditRiskCode,
} from './risk-codes';
import type { DiditWarningEntry } from './types';

/**
 * Result of resolving a decline reason.
 */
export interface DeclineReasonResult {
  /** The risk code. May be `null` if no error/warning-level entries fired. */
  readonly code: string | null;
  /** Human-readable short description from the originating warning. */
  readonly text: string | null;
}

/**
 * Pre-computed priority index map for O(1) priority lookup. Lower
 * index = higher priority (matches `DIDIT_DECLINE_REASON_PRIORITY`
 * array order in `risk-codes.ts`).
 */
const PRIORITY_INDEX: ReadonlyMap<DiditRiskCode, number> = new Map(
  DIDIT_DECLINE_REASON_PRIORITY.map((code, index) => [code, index]),
);

/**
 * Pick the highest-priority decline reason from a flat warnings list.
 *
 * @param warnings - aggregated across all per-feature blocks (already
 *   flat / pre-tagged with `feature`).
 * @returns `(code, text)` or `(null, null)` if no actionable warning.
 */
export function resolveDeclineReason(
  warnings: readonly DiditWarningEntry[],
): DeclineReasonResult {
  if (warnings.length === 0) {
    return { code: null, text: null };
  }

  // Filter out information-level entries — they are not decline reasons.
  const actionable = warnings.filter((w) => w.logType !== 'information');
  if (actionable.length === 0) {
    return { code: null, text: null };
  }

  let bestKnownIndex = Number.POSITIVE_INFINITY;
  let bestKnown: DiditWarningEntry | null = null;
  let firstUnknown: DiditWarningEntry | null = null;

  for (const entry of actionable) {
    const idx = PRIORITY_INDEX.get(entry.risk as DiditRiskCode);
    if (idx === undefined) {
      // Unknown code — Didit shipped a new code we don't catalog.
      // Remember the FIRST one as a tail-fallback so the operator has
      // something to grep, but never let unknowns outrank known codes.
      if (firstUnknown === null) firstUnknown = entry;
      continue;
    }
    if (idx < bestKnownIndex) {
      bestKnownIndex = idx;
      bestKnown = entry;
    }
  }

  const winner = bestKnown ?? firstUnknown;
  if (winner === null) return { code: null, text: null };

  return {
    code: winner.risk,
    text: winner.shortDescription ?? null,
  };
}
