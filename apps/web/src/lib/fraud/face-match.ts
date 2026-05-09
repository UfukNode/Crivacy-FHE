/**
 * Face-match evaluator — Sprint 6's central single source of truth
 * for the 10 face-match scenarios laid out in the Sprint 6 plan.
 * Consumes a hydrated `DiditDecisionPayload` plus the current
 * session's context (customer self-signup vs B2B firm-issued) and
 * returns a discriminated `FaceMatchEvaluation` that the webhook
 * handler dispatches on.
 *
 * Design rules:
 *   - PURE function. Account-status lookup is injected via `deps`
 *     so the evaluator is unit-testable without DB.
 *   - Worst-case rule (scenario 10): the strictest classification
 *     across ALL matches wins. Any banned hit → `cascade_fraud`;
 *     any Didit fraud signal → `cascade_fraud`; otherwise the
 *     individual match outcomes resolve.
 *   - Same-customer hit (scenario 1) returns `no_match` so the
 *     normal mint path proceeds — the user is just re-verifying
 *     their own credential.
 *   - Email masking lives here (`maskEmail`) so every UI
 *     surface that needs to render the toast text reads the same
 *     deterministic shape.
 *
 * Naming: returns a SCENARIO LABEL (`no_match` / `reuse` /
 * `block_toast` / `cascade_fraud`), not a status code or action
 * verb. The downstream handler decides the actual mutations
 * (cascade-ban + revoke-webhooks vs mint-fresh vs disclose-existing).
 */

import {
  DIDIT_DUPLICATE_DETECTION_SET,
  DIDIT_FRAUD_SIGNAL_SET,
  type DiditRiskCode,
} from '@crivacy-fhe/adapter-didit/risk-codes';
import type {
  DiditDecisionPayload,
  DiditMatchEntry,
  DiditWarningEntry,
} from '@crivacy-fhe/adapter-didit/types';
import {
  parseSessionVendorData,
  type ParsedSessionVendorData,
} from '@crivacy-fhe/adapter-didit/vendor-data';

/**
 * Status of a matched account, as resolved by the deps-injected
 * lookup. Drives the cascade-vs-block_toast decision in the
 * evaluator.
 */
export type MatchedAccountStatus =
  | {
      readonly kind: 'customer_banned';
      readonly customerId: string;
      readonly email: string | null;
    }
  | {
      readonly kind: 'customer_clean';
      readonly customerId: string;
      readonly email: string | null;
    }
  | {
      readonly kind: 'b2b_only';
      readonly firmId: string;
      readonly userRef: string;
    }
  | { readonly kind: 'unknown' };

/**
 * One face_search match enriched with the resolved account status.
 * `match` is the raw projection from `DiditDecisionPayload.faceSearchMatches`;
 * `status` is the result of looking up the matched session's owner.
 */
export interface ResolvedMatch {
  readonly match: DiditMatchEntry;
  readonly status: MatchedAccountStatus;
}

/**
 * Context of the CURRENT session being evaluated. Determines the
 * scenario classification when the evaluator can't tell from the
 * match alone (e.g. scenario 1 needs the current customerId to
 * compare against the matched session's customerId).
 */
export type FaceMatchContext =
  | {
      readonly kind: 'customer';
      readonly customerId: string;
    }
  | {
      readonly kind: 'b2b';
      readonly firmId: string;
      readonly userRef: string;
    };

/**
 * Result of evaluating face-match for the current session.
 *
 * Branches and the Sprint 6 scenario(s) they cover:
 *   - `no_match` — scenarios 1 (same customer) + clean baseline
 *     (no face_search hit at all).
 *   - `reuse` — scenarios 3 (B2B+B2B clean) + 4 clean variant
 *     (B2B X + customer self-signup, no fraud).
 *   - `block_toast` — scenarios 2, 7, 8 (different Crivacy
 *     account that is clean / locked / suspended).
 *   - `cascade_fraud` — scenarios 5, 6, and the fraud variants
 *     of 3/4 (any Didit fraud signal OR matched banned account).
 */
export type FaceMatchEvaluation =
  | { readonly kind: 'no_match' }
  | {
      readonly kind: 'reuse';
      readonly resolvedMatch: ResolvedMatch;
    }
  | {
      readonly kind: 'block_toast';
      readonly resolvedMatch: ResolvedMatch;
      readonly maskedEmail: string;
    }
  | {
      readonly kind: 'cascade_fraud';
      readonly resolvedMatches: readonly ResolvedMatch[];
      readonly reasonCode: DiditRiskCode | 'matched_banned_account';
    };

/**
 * Lookup contract injected into the evaluator. Production wiring
 * (`server/handlers/didit-webhook.ts`) parses each match's
 * `vendor_data` JSON, derives `customerId` / `firmId+userRef`,
 * and queries the customer / firm-user tables to resolve the
 * status. Tests provide an in-memory implementation.
 */
export interface FaceMatchLookup {
  /**
   * Resolve the status of every match's owner. Implementation MUST
   * preserve order — the worst-case rule walks the resolved array
   * positionally to derive the email-mask target (the most-recent
   * clean match by `verificationDate`).
   */
  resolveMatches(matches: readonly DiditMatchEntry[]): Promise<readonly ResolvedMatch[]>;
}

/**
 * Parse a face_search `match.vendor_data` JSON string into the
 * fields we attached when creating the matched session.
 *
 * Thin wrapper over the canonical `parseSessionVendorData` helper
 * (`lib/didit/vendor-data.ts`) — kept under the historical name so
 * existing call sites and tests can continue to import it. Both the
 * face-match cascade lookup and the inbound webhook parser MUST go
 * through the canonical helper to avoid the field-name slip we hit
 * pre-Sprint-6 (`crivacyKycSessionId` vs `crivacySessionId`).
 */
export type ParsedMatchVendorData = ParsedSessionVendorData;

export function parseMatchVendorData(raw: string | null): ParsedMatchVendorData | null {
  if (raw === null) return null;
  return parseSessionVendorData(raw);
}

/**
 * Mask an email address to the Sprint 6 toast format
 * `a...d@***.com` (first + last char of the local-part + the
 * standard masked domain). Single source of truth — every UI
 * surface that renders the "this face is bound to X" toast reads
 * the output of this helper.
 *
 * Edge cases:
 *   - Local-part of length 1 → `a@***.com` (no ellipsis, no
 *     repeated char).
 *   - Local-part of length 2 → `ad@***.com` (both chars shown,
 *     no ellipsis — masking adds no privacy benefit).
 *   - Length 0 / no `@` → fully-masked `***@***.com` so we never
 *     leak partial emails on malformed input.
 */
export function maskEmail(email: string | null | undefined): string {
  if (typeof email !== 'string' || email.length === 0) return '***@***.com';
  const atIdx = email.indexOf('@');
  if (atIdx <= 0) return '***@***.com';
  const local = email.slice(0, atIdx);
  if (local.length === 1) return `${local}@***.com`;
  if (local.length === 2) return `${local}@***.com`;
  return `${local[0]}...${local[local.length - 1]}@***.com`;
}

/**
 * Filter `decision.warnings` to those that always trigger cascade
 * fraud regardless of any other signal — Didit fraud signals.
 *
 * Note: `DUPLICATED_FACE` is NOT in this list because cascade for
 * that code depends on the matched account status (banned vs
 * clean). The evaluator handles that via the worst-case rule.
 */
function pickFraudSignals(
  warnings: readonly DiditWarningEntry[],
): readonly DiditWarningEntry[] {
  return warnings.filter((w) => DIDIT_FRAUD_SIGNAL_SET.has(w.risk as DiditRiskCode));
}

/**
 * Pick the most-recent clean customer match for the email-mask
 * target. Falls back to the first clean customer match if no
 * `verificationDate` is set on any entry.
 */
function pickToastTarget(resolved: readonly ResolvedMatch[]): ResolvedMatch | null {
  const cleanCustomers = resolved.filter(
    (r): r is ResolvedMatch & { status: { kind: 'customer_clean' } } =>
      r.status.kind === 'customer_clean',
  );
  if (cleanCustomers.length === 0) return null;
  // Sort by verificationDate desc — newest first. Entries without a
  // date sink to the bottom.
  const sorted = [...cleanCustomers].sort((a, b) => {
    const aDate = a.match.verificationDate ?? '';
    const bDate = b.match.verificationDate ?? '';
    if (aDate === bDate) return 0;
    return aDate < bDate ? 1 : -1;
  });
  return sorted[0] ?? null;
}

/**
 * Pick the reuse target — the first b2b-only match (no customer
 * account). When the current context is a customer self-signup
 * (scenario 4) we still pick the b2b-only match here; the caller
 * does the double-bind to the current customer.
 */
function pickReuseTarget(resolved: readonly ResolvedMatch[]): ResolvedMatch | null {
  return resolved.find((r) => r.status.kind === 'b2b_only') ?? null;
}

/**
 * Evaluate face-match for the current session.
 *
 * Algorithm (worst-case-first):
 *   1. Didit fraud signals → cascade_fraud (no DB lookup needed).
 *   2. No `faceSearchMatches[]` AND no fraud → no_match.
 *   3. Resolve every match's account status via deps.
 *   4. Any matched account is `customer_banned` → cascade_fraud.
 *   5. Any matched account is `customer_clean` AND it's the same
 *      customer as the current session → no_match (scenario 1).
 *   6. Any matched account is `customer_clean` (different
 *      customer) → block_toast with masked email (scenario 2/7/8).
 *   7. All matches are `b2b_only` → reuse the existing tx
 *      (scenarios 3 + 4-clean variant).
 *   8. Fallback: `no_match` (vendor_data unparseable on every
 *      match — log for ops review).
 */
export async function evaluateFaceMatch(
  deps: { readonly lookup: FaceMatchLookup },
  decision: DiditDecisionPayload,
  context: FaceMatchContext,
): Promise<FaceMatchEvaluation> {
  // 1. Didit fraud signals — always cascade.
  const fraudSignals = pickFraudSignals(decision.warnings);
  if (fraudSignals.length > 0) {
    const resolved = await deps.lookup.resolveMatches(decision.faceSearchMatches);
    return {
      kind: 'cascade_fraud',
      resolvedMatches: resolved,
      reasonCode: fraudSignals[0]!.risk as DiditRiskCode,
    };
  }

  // 2. No matches — proceed with normal mint.
  if (decision.faceSearchMatches.length === 0) {
    return { kind: 'no_match' };
  }

  // 3. Resolve every match's owner.
  const resolved = await deps.lookup.resolveMatches(decision.faceSearchMatches);

  // 4. Any banned customer match → cascade_fraud (scenario 5).
  const bannedHits = resolved.filter((r) => r.status.kind === 'customer_banned');
  if (bannedHits.length > 0) {
    return {
      kind: 'cascade_fraud',
      resolvedMatches: resolved,
      reasonCode: 'matched_banned_account',
    };
  }

  // 5. Same-customer hit — scenario 1, no engel.
  if (context.kind === 'customer') {
    const sameCustomer = resolved.find(
      (r) =>
        r.status.kind === 'customer_clean' &&
        r.status.customerId === context.customerId,
    );
    if (sameCustomer !== undefined) return { kind: 'no_match' };
  }

  // 6. Different clean customer match — toast (scenario 2/7/8).
  const toastTarget = pickToastTarget(resolved);
  if (toastTarget !== null && toastTarget.status.kind === 'customer_clean') {
    return {
      kind: 'block_toast',
      resolvedMatch: toastTarget,
      maskedEmail: maskEmail(toastTarget.status.email),
    };
  }

  // 7. B2B-only match — reuse (scenario 3 + 4-clean).
  const reuseTarget = pickReuseTarget(resolved);
  if (reuseTarget !== null) {
    return { kind: 'reuse', resolvedMatch: reuseTarget };
  }

  // 8. All matches were unknown / unparseable — proceed with normal
  // mint. The webhook handler logs the resolved-status array so
  // ops can investigate (Didit shipped a new vendor_data shape).
  return { kind: 'no_match' };
}

/**
 * Internal helper — exported for the cascade-ban path to extract
 * the duplicate-detection warning that triggered the evaluation.
 * The cascade row in `customer_blacklist` records the underlying
 * Didit risk code so the audit trail is faithful.
 */
export function pickDuplicateDetectionCode(
  warnings: readonly DiditWarningEntry[],
): DiditRiskCode | null {
  const hit = warnings.find((w) => DIDIT_DUPLICATE_DETECTION_SET.has(w.risk as DiditRiskCode));
  return hit ? (hit.risk as DiditRiskCode) : null;
}
