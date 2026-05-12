/**
 * KYC phase registry — single source of truth.
 *
 * Sprint 9 unification: every customer-facing KYC step (identity,
 * address, soulbound NFT mint) is described by ONE registry entry.
 * Handlers, the `/kyc` step page, the `/kyc/callback` page, OAuth
 * fast-path entry-point selection, and the reconciler worker all
 * read from here. Adding a phase = adding one entry; removing a
 * phase = deleting one entry. No surface gets to hardcode the level
 * thresholds, the step copy, or the callback variant mapping.
 *
 * Why a registry, not a switch
 * ----------------------------
 * Pre-Sprint 9 the same phase semantics were spread across at least
 * five surfaces:
 *
 *   * `app/(customer)/kyc/page.tsx` — `levelNum >= 3` / `levelNum >= 4`
 *     hardcoded thresholds for every step
 *   * `server/handlers/customer-kyc.ts` — duplicated thresholds in
 *     `handleStartIdentity` / `handleStartAddress` eligibility gates
 *   * `app/api/customer/kyc/start-from-consent/route.ts` —
 *     `needsAddressOnly` ad-hoc derivation
 *   * `app/kyc/callback/page.tsx` — its own private `statusToVariant`
 *   * `(customer)/kyc/address/page.tsx` — its own copy of "what does
 *     address need" requirements text (deleted Sprint 10; the address
 *     phase now renders inline through `KycActionPanel`)
 *
 * Each surface had its own mental model of "how do I tell whether
 * identity is done?" The Sprint 8 address-phase live test caught the
 * drift: the callback page rendered "Verification complete" off a
 * URL query parameter while the backend still had the session marked
 * pending (webhook 401 mid-flow). Centralising the contract here
 * makes that class of drift impossible — every surface that wants to
 * know "is identity active?" calls `resolveStepStatus(state)` on the
 * same registry entry.
 *
 * Trust boundary
 * --------------
 * `resolveCallbackVariant()` takes a real `KycStatus` (sourced
 * server-side from the `kyc_sessions` row). The callback page does
 * NOT pass a URL query param into this function: that path is closed
 * off entirely and the page polls a backend endpoint for the real
 * status.
 *
 * Audience
 * --------
 * Pure types + functions, no IO, no React imports. Safe to import
 * from server handlers, workers, and React components alike.
 */

import type { KycStatus } from '@crivacy/shared-types';

import type { ScopeRequiredLevel } from '@/lib/oauth/scopes-catalog';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/**
 * The customer KYC level enum, mirrored from the Postgres
 * `customer_kyc_level` enum (see `lib/db/schema/enums.ts`). Keeping
 * the union here lets registry consumers narrow without importing
 * the Drizzle schema.
 *
 *   * `kyc_0` — no verification started
 *   * `kyc_1` — email verified (no Didit step yet)
 *   * `kyc_2` — Didit approved the document but liveness is still
 *               pending (degraded). Surfaces as identity-in-review.
 *   * `kyc_3` — Identity fully verified → Basic credential issued
 *   * `kyc_4` — Address verified → Enhanced credential issued
 */
export type CustomerKycLevel = 'kyc_0' | 'kyc_1' | 'kyc_2' | 'kyc_3' | 'kyc_4';

/** Phase identifiers. Add new entries here AND in `KYC_PHASES` below. */
export type KycPhaseId = 'identity' | 'address' | 'nft_mint';

/**
 * Step status as rendered by the `/kyc` stepper. Mirrors
 * `KycStep['status']` from `components/customer/kyc-stepper.tsx` —
 * the registry is the producer, the stepper is the consumer.
 *
 *   * `minting` — Didit returned a terminal-positive decision
 *     (`identity_approved` / `approved`) AND the credential-pipeline
 *     worker has not yet committed the on-chain mint, so the parent
 *     row should show "in flight" instead of either "active" (start
 *     CTA, false negative) or "completed" (✓ green, false positive).
 *     Sub-step list under this status surfaces the per-attempt mint
 *     state via the `MintProgress` input.
 *
 *   * `failed` — credential-pipeline retries exhausted. The parent
 *     row turns red. Sub-step list explains "retries exhausted —
 *     contact support" so the customer is not left guessing.
 */
export type StepStatus = 'locked' | 'active' | 'in_review' | 'minting' | 'completed' | 'failed';

/**
 * Variant the callback page renders. Mirrors the original
 * `CallbackVariant` union from `app/kyc/callback/page.tsx`, now
 * sourced from real backend session state instead of URL params.
 */
export type CallbackVariant = 'approved' | 'in_review' | 'declined' | 'in_progress' | 'unknown';

/**
 * Per-phase credential-pipeline mint progress snapshot.
 *
 * Built server-side in `handleGetKycStatus` from the union of
 * `kyc_credentials_meta` (mint already landed?) and the pg-boss
 * `pgboss.job` row (in flight? retrying? exhausted?). `null` means
 * "not in the mint window" — the customer hasn't reached
 * `identity_approved` / `approved` for this phase yet, so there is
 * no mint to track.
 *
 * Keeps the "Didit-approved but not on chain yet" gap visible to the
 * customer; pre-Sprint-DC the /kyc stepper showed an "Active — start
 * verification" CTA in this window because the level was still
 * `kyc_0` (atomic mint TX hadn't bumped it). The customer interpreted
 * that as "my Approved decision was lost".
 */
export interface MintProgress {
  /**
   * `pending` — pg-boss job is `created`/`active`, no retries yet.
   * `retrying` — pg-boss job is in `retry` state with `retry_count > 0`.
   * `completed` — `kyc_credentials_meta` has an `active` row for the
   *               session (worker landed the on-chain commit + DB INSERT).
   * `failed` — pg-boss job exhausted its `retry_limit` and went to
   *            `failed`. Customer needs ops escalation.
   */
  readonly state: 'pending' | 'retrying' | 'completed' | 'failed';
  /** Current attempt number (`retry_count + 1`). 1-indexed for UI. */
  readonly attempts: number;
  /**
   * Total budget (`retry_limit + 1`). Matches the `retryLimit: 5`
   * constant in `enqueueCredentialPipeline`, so default value here is 6.
   */
  readonly totalAttempts: number;
}

/**
 * Snapshot a registry consumer hands in to ask the resolvers
 * questions. Built once per `/kyc` page render from `useKycStatus`,
 * or once per registry call from a handler.
 */
export interface PhaseStateInput {
  readonly customerKycLevel: CustomerKycLevel;
  /**
   * `true` if the customer has a non-terminal `kyc_sessions` row
   * for this phase's Didit workflow (covers pending / in_progress /
   * resubmission_pending / identity_approved / address_in_progress).
   * `false` for phases without a Didit workflow (`nft_mint`).
   */
  readonly hasActiveSession: boolean;
  /**
   * `true` when Didit returned `in_review` or `resubmission_pending`
   * on this phase's most recent session. Drives the `in_review`
   * step status so the stepper shows "review in progress" instead
   * of the start CTA.
   */
  readonly inReview: boolean;
  /**
   * `true` when there is a `kyc_sessions` row whose status is
   * specifically `pending` or `in_progress` for this phase's
   * workflow — i.e. the customer is *actively* in the Didit hosted
   * flow on some device right now (QR-handed-off phone or this
   * desktop tab). Drives the sub-step "Verifying…" `in_progress`
   * visual so the stepper communicates that work is actively
   * happening, not just queued.
   *
   * Distinct from `hasActiveSession` (which is broader and includes
   * `in_review` / `identity_approved` / `address_in_progress` — those
   * mean Didit has the decision; the customer is no longer in the
   * capture flow on a device).
   *
   * `false` for phases without a Didit workflow (`nft_mint`).
   */
  readonly sessionInFlight: boolean;
  /**
   * Soulbound NFT contract id, populated only when the on-chain
   * mint has succeeded. `null` for: not minted yet, mint in flight,
   * or burned post-revoke. Only consulted by the `nft_mint` phase.
   */
  readonly nftContractId: string | null;
  /**
   * Per-phase credential-pipeline mint state. `null` outside the
   * mint window. Drives the `minting` / `failed` step statuses
   * + the "Issuing credential" sub-step row. See `MintProgress`
   * docs for state meaning.
   */
  readonly mintProgress: MintProgress | null;
}

/**
 * Optional sub-step list rendered under a phase row in the stepper.
 * `in_progress` shows a pulsing dot while a long-running off-chain
 * step (today: chain submit-and-wait) is in flight; `failed` shows
 * a red marker for terminal failure. Identity uses both for the
 * "Issuing credential on Sepolia" row that lives under the document
 * + liveness checkmarks.
 */
export interface PhaseSubStep {
  readonly label: string;
  readonly status: 'completed' | 'pending' | 'in_progress' | 'failed';
}

export interface PhaseDefinition {
  readonly id: KycPhaseId;
  readonly stepLabel: string;

  /**
   * Didit workflow this phase routes to, or `null` for purely
   * on-chain phases (mint). Used by handlers to dispatch session
   * creation and by the reconciler to scope its drift query.
   */
  readonly diditWorkflow: 'identity' | 'address' | null;

  /**
   * Backend POST endpoint that opens this phase. `null` for the
   * mint phase, which is opened from a different surface
   * (`POST /api/customer/credential/mint-nft`). The OAuth fast path
   * picks the entry phase and the start-session handler invoked
   * here; UI pages route the user to the same endpoint by clicking
   * the active step.
   */
  readonly startEndpoint: string | null;

  /**
   * Lowest customer KYC level at which this phase is open for
   * starting (i.e. any level < this is "locked" for this phase).
   * Modeled as the level enum value, not a number, so a future
   * level addition is a TS error here.
   */
  readonly opensAtLevel: CustomerKycLevel;

  /**
   * Exact set of customer KYC levels at which the start-session
   * handler will accept a new session for this phase. Stricter than
   * `opensAtLevel <= rank < completesAtLevel`: the in-flight level
   * (e.g. `kyc_2` for identity = "document parsed, liveness pending"
   * — owned by Didit) is excluded, so the user must wait for the
   * webhook rather than spawn a parallel session. The handler
   * checks this with a simple `includes` and rejects with
   * `kyc_level_ineligible` (409) on mismatch.
   *
   * Empty array for phases that aren't started by a session POST
   * (mint — opened from the credential-mint endpoint instead).
   */
  readonly eligibleStartLevels: readonly CustomerKycLevel[];

  /**
   * Customer KYC level the customer reaches once this phase
   * completes successfully. `null` for phases that don't move the
   * level (mint stamps an NFT contract id but does not bump
   * `customer_kyc_level`).
   */
  readonly completesAtLevel: CustomerKycLevel | null;

  /**
   * Scope-level this phase satisfies once completed. Used by the
   * OAuth fast path to decide which phase to open when the
   * requested scope set demands a higher level than the user's
   * current credential. `null` for phases not gated by scopes
   * (mint).
   */
  readonly satisfiesScopeLevel: ScopeRequiredLevel;

  /**
   * Whether this phase's hosted flow supports phone handoff via QR.
   * Sprint 10: both identity AND address support handoff — the
   * `handleCreateHandoff` backend is phase-agnostic (picks any active
   * `kyc_sessions` row), and the unified `KycActionPanel` reads this
   * flag to decide whether to render the QR sub-section. Mint phase
   * stays `false` because it has no hosted Didit flow at all.
   */
  readonly supportsHandoff: boolean;

  /**
   * Whether the primary "Start" button should default to opening the
   * QR sub-section inline instead of redirecting the desktop tab to
   * Didit. Identity is `false` (desktop selfie capture is the
   * intended primary path; QR is a camera-unavailable fallback).
   * Address is `true` (utility-bill photo is mobile-first; even on a
   * device with a camera, scanning a QR to phone is the better UX).
   * Mint is `false` because it has no Didit step.
   *
   * Sprint 10: introduced when the live address-phase test (5th
   * attempt — $1.00 burned across attempts) revealed that desktop
   * redirect on click was a UX regression for address. Pre-registry
   * the address standalone page had a separate `<DeviceHandoff>`
   * card the customer could opt into; the unified panel collapses
   * that into a single primary action.
   */
  readonly defaultsToHandoff: boolean;

  /**
   * Whether the reconciler should poll Didit for forward-drift
   * (Approved decision the webhook missed) on this phase. `false`
   * for phases without a Didit workflow.
   */
  readonly supportsForwardDriftReconciliation: boolean;

  /**
   * Whether this phase's session lifecycle should be re-checked
   * by the reverse-drift reconciler (close orphan sessions for
   * customers whose credentials are revoked).
   */
  readonly supportsReverseDriftReconciliation: boolean;

  /** Description copy in 4 states (locked/active/in_review/completed). */
  readonly describe: (state: PhaseStateInput) => string;

  /** Resolve UI step status from current state. */
  readonly resolveStepStatus: (state: PhaseStateInput) => StepStatus;

  /**
   * Optional per-state sub-step list. Only `identity` returns a
   * non-null array today (its sub-bullets are document + liveness).
   */
  readonly subSteps?: (state: PhaseStateInput) => readonly PhaseSubStep[];

  /**
   * Map a real backend `kyc_sessions.status` to a callback page
   * variant. The callback page's previous URL-param mapping is
   * obsolete; this is the only mapper in the codebase. Returns
   * `null` for phases that don't redirect through the callback page
   * (mint).
   */
  readonly resolveCallbackVariant: ((sessionStatus: KycStatus | null) => CallbackVariant) | null;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                  */
/* ------------------------------------------------------------------ */

const LEVEL_RANK: Record<CustomerKycLevel, number> = Object.freeze({
  kyc_0: 0,
  kyc_1: 1,
  kyc_2: 2,
  kyc_3: 3,
  kyc_4: 4,
});

/**
 * Canonical ordered list of customer KYC levels. Mirrors the
 * `customer_kyc_level` Postgres enum; a future enum addition is a
 * compile error here first because `LEVEL_RANK` is keyed on the
 * union type. Used by guard helpers, the reconciler, and tests.
 */
export const CUSTOMER_KYC_LEVELS: readonly CustomerKycLevel[] = Object.freeze([
  'kyc_0',
  'kyc_1',
  'kyc_2',
  'kyc_3',
  'kyc_4',
]);

/** Return the numeric rank for a customer KYC level, for comparisons. */
export function rankCustomerKycLevel(level: CustomerKycLevel): number {
  return LEVEL_RANK[level];
}

/**
 * Type guard: narrow a string to `CustomerKycLevel`. Single source
 * of truth for "is this string a valid customer KYC level?" — the
 * pre-Sprint-9 codebase had three independent copies of the same
 * array literal sprinkled across handlers and types.
 */
export function isCustomerKycLevel(value: string): value is CustomerKycLevel {
  return (CUSTOMER_KYC_LEVELS as readonly string[]).includes(value);
}

/**
 * Canonical Didit `KycStatus` → callback variant resolver, shared by
 * every Didit-driven phase. Address and identity render the same
 * variants for the same backend state — the registry just exposes
 * the same function as `resolveCallbackVariant` on each phase.
 *
 * `null` input maps to `unknown`: the callback page calls this with
 * `null` when the session row could not be located server-side
 * (e.g. cookie-less phone landing, no auth context). The page's
 * loading branch handles `unknown` as "submitted, return to your
 * desktop".
 */
function diditSessionStatusToCallbackVariant(status: KycStatus | null): CallbackVariant {
  if (status === null) return 'unknown';
  switch (status) {
    case 'approved':
    // `identity_approved` is the terminal success state of the identity
    // workflow: Didit approved identity + liveness, the credential mint
    // is enqueued and proceeds async. For the callback surface (esp. the
    // phone-handoff device) this is DONE — the user should see
    // "Verification complete, return to your computer" and stop polling,
    // NOT sit on a non-terminal spinner until the 30s timeout falls
    // through to "still processing". The mint window UI lives on the
    // desktop /kyc dashboard, not on this hand-off callback page.
    case 'identity_approved':
      return 'approved';
    case 'in_review':
      return 'in_review';
    case 'rejected':
    case 'expired':
    case 'revoked':
    case 'kyc_expired':
      return 'declined';
    case 'pending':
    case 'in_progress':
    case 'address_in_progress':
    case 'resubmission_pending':
      return 'in_progress';
    default: {
      // Exhaustiveness guard. If `KycStatus` ever gains a new value,
      // this will no longer be `never` and TypeScript will fail the
      // build until we map the new state.
      const _exhaustive: never = status;
      void _exhaustive;
      return 'unknown';
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Phase definitions                                                 */
/* ------------------------------------------------------------------ */

function resolveIdentityStepStatus(state: PhaseStateInput): StepStatus {
  const rank = rankCustomerKycLevel(state.customerKycLevel);
  if (rank >= LEVEL_RANK.kyc_3) return 'completed';
  // Mint window — Didit decision is in, on-chain commit still in flight
  // (or exhausted retries). This branch is checked BEFORE the level-
  // based fallbacks because in this window `customer.kyc_level` is
  // still `kyc_0` / `kyc_1` (the atomic mint TX hasn't bumped it
  // yet, see Sprint 7 Phase I), so the rank check below would
  // otherwise mislabel the step as `active` ("Start verification").
  if (state.mintProgress !== null) {
    if (state.mintProgress.state === 'failed') return 'failed';
    return 'minting';
  }
  if (rank === LEVEL_RANK.kyc_2 || state.inReview) return 'in_review';
  return 'active';
}

const IDENTITY: PhaseDefinition = Object.freeze({
  id: 'identity' as const,
  stepLabel: 'Identity Verification',
  diditWorkflow: 'identity' as const,
  startEndpoint: '/api/customer/kyc/start-identity',
  opensAtLevel: 'kyc_0' as const,
  completesAtLevel: 'kyc_3' as const,
  eligibleStartLevels: Object.freeze(['kyc_0', 'kyc_1'] as const),
  satisfiesScopeLevel: 'basic' as ScopeRequiredLevel,
  supportsHandoff: true,
  defaultsToHandoff: false,
  supportsForwardDriftReconciliation: true,
  supportsReverseDriftReconciliation: true,
  describe(state: PhaseStateInput): string {
    const status = resolveIdentityStepStatus(state);
    if (status === 'completed') {
      return 'Government-issued ID and biometric liveness verified.';
    }
    if (status === 'minting') {
      return 'Decision approved. Issuing your credential on Sepolia.';
    }
    if (status === 'failed') {
      return 'Credential issuance failed. Our team has been notified, please contact support.';
    }
    if (status === 'in_review') {
      // Honest wording: Didit's V3 flow does NOT report per-check
      // (document vs liveness) ordering to us — only a session-level
      // in-progress/review/approved status. So we must NOT claim the
      // document passed while liveness is pending (that granularity is
      // never sent). State what is actually true: identity verification
      // is still running.
      return 'Verifying your identity (ID document and liveness)…';
    }
    return 'Verify your identity with a government-issued ID and a quick selfie liveness check.';
  },
  resolveStepStatus: resolveIdentityStepStatus,
  subSteps(state: PhaseStateInput): readonly PhaseSubStep[] {
    const rank = rankCustomerKycLevel(state.customerKycLevel);
    // In the mint window (Didit approved, on-chain commit pending /
    // retrying / failed) the level is still pre-`kyc_3` because the
    // atomic mint TX hasn't bumped it yet. ID + liveness are both
    // implicitly done in that case (Didit told us so), so the
    // sub-step rows render green regardless of the rank check.
    const inMintWindow = state.mintProgress !== null;
    // Document + liveness flip together, never one-done-one-pending.
    // Didit does not tell us which sub-check finished first (see the
    // `in_review` copy note above), so surfacing "ID verified ✓" while
    // "Verifying liveness" is still spinning would be a fabricated
    // ordering. Both complete together the moment Didit approves
    // identity (rank reaches kyc_3, or we are already in the mint
    // window issuing the credential).
    const identityDone = inMintWindow || rank >= LEVEL_RANK.kyc_3;
    const docDone = identityDone;
    const livenessDone = identityDone;

    // When the customer is actively in Didit's hosted flow (session
    // status is pending / in_progress), the not-yet-completed
    // sub-steps surface as `in_progress` instead of the default
    // `pending` so the stepper communicates "work is happening right
    // now, not just queued". Didit's V3 webhook stream does NOT emit
    // per-step (document → liveness → face-match) events during the
    // capture flow — only the session-level pending → in_progress →
    // approved transitions — so the stepper cannot tick the rows in
    // their true order. Surfacing both in-flight rows as
    // `in_progress` together is the truthful representation: work IS
    // happening on each row, we just do not know which one Didit is
    // running this exact millisecond. Outside the in-flight window
    // they fall back to `pending`.
    const docPendingStatus: PhaseSubStep['status'] = state.sessionInFlight
      ? 'in_progress'
      : 'pending';
    const livenessPendingStatus: PhaseSubStep['status'] = state.sessionInFlight
      ? 'in_progress'
      : 'pending';

    const baseSteps: PhaseSubStep[] = [
      {
        label: docDone ? 'ID document verified' : 'Verifying ID document',
        status: docDone ? 'completed' : docPendingStatus,
      },
      {
        label: livenessDone ? 'Liveness verified' : 'Verifying liveness',
        status: livenessDone ? 'completed' : livenessPendingStatus,
      },
    ];

    // Third "Issuing credential" sub-step renders only when there is
    // a credential to talk about: either we are in the mint window
    // OR the mint has already landed (rank >= kyc_3). Phase 2
    // (address) emits its own variant elsewhere; the identity row
    // only reports on Phase 1's basic credential.
    const mintLanded = rank >= LEVEL_RANK.kyc_3 && state.mintProgress === null;
    if (state.mintProgress !== null) {
      baseSteps.push({
        label:
          state.mintProgress.state === 'failed'
            ? `Credential issuance failed (attempt ${state.mintProgress.attempts} of ${state.mintProgress.totalAttempts})`
            : state.mintProgress.state === 'retrying'
              ? `Retrying credential issuance — attempt ${state.mintProgress.attempts} of ${state.mintProgress.totalAttempts}`
              : 'Issuing credential on Sepolia…',
        status:
          state.mintProgress.state === 'failed'
            ? 'failed'
            : state.mintProgress.state === 'completed'
              ? 'completed'
              : 'in_progress',
      });
    } else if (mintLanded) {
      baseSteps.push({
        label: 'Credential issued on Sepolia',
        status: 'completed',
      });
    }

    return Object.freeze(baseSteps.map((s) => Object.freeze(s)));
  },
  resolveCallbackVariant: diditSessionStatusToCallbackVariant,
});

function resolveAddressStepStatus(state: PhaseStateInput): StepStatus {
  const rank = rankCustomerKycLevel(state.customerKycLevel);
  if (rank >= LEVEL_RANK.kyc_4) return 'completed';
  // Mint window for the address phase — Didit returned `approved`,
  // on-chain Enhanced credential commit is in flight. Same gap
  // problem identity has: `customer.kyc_level` is still `kyc_3`
  // until the atomic mint TX bumps it, so without this branch the
  // step shows "active — Start address verification" again.
  if (state.mintProgress !== null) {
    if (state.mintProgress.state === 'failed') return 'failed';
    return 'minting';
  }
  if (state.inReview) return 'in_review';
  if (rank >= LEVEL_RANK.kyc_3) return 'active';
  return 'locked';
}

const ADDRESS: PhaseDefinition = Object.freeze({
  id: 'address' as const,
  stepLabel: 'Address Verification',
  diditWorkflow: 'address' as const,
  startEndpoint: '/api/customer/kyc/start-address',
  opensAtLevel: 'kyc_3' as const,
  completesAtLevel: 'kyc_4' as const,
  eligibleStartLevels: Object.freeze(['kyc_3'] as const),
  satisfiesScopeLevel: 'enhanced' as ScopeRequiredLevel,
  // Sprint 10: handoff enabled for parity with identity. Didit's
  // hosted address flow (utility bill / bank statement upload) is
  // mobile-friendly out of the box, and `handleCreateHandoff` is
  // already phase-agnostic — it picks any active session, so the
  // same backend serves identity + address QR with no code change.
  // Pre-Sprint 10 state was `false` because we hadn't surfaced a
  // unified action panel on the /kyc step page; now both phases
  // render `KycActionPanel` and address callers reach the same QR
  // sub-section identity has used since K1.
  supportsHandoff: true,
  // Address defaults to the QR sub-section on click — utility-bill
  // photo is a mobile-first interaction. Even on a desktop with a
  // camera the user is better off scanning a QR to phone. Pre-Sprint-
  // 10 the dedicated /kyc/address page had a separate <DeviceHandoff>
  // card; the unified panel collapses that into the primary action.
  defaultsToHandoff: true,
  supportsForwardDriftReconciliation: true,
  supportsReverseDriftReconciliation: true,
  describe(state: PhaseStateInput): string {
    const status = resolveAddressStepStatus(state);
    if (status === 'completed') {
      return 'Address verified - Enhanced credential issued on-chain.';
    }
    if (status === 'minting') {
      return 'Address verified. Issuing your Enhanced credential on Sepolia.';
    }
    if (status === 'failed') {
      return 'Credential issuance failed. Our team has been notified, please contact support.';
    }
    return 'Verify your residential address with a utility bill or bank statement.';
  },
  resolveStepStatus: resolveAddressStepStatus,
  subSteps(state: PhaseStateInput): readonly PhaseSubStep[] {
    const rank = rankCustomerKycLevel(state.customerKycLevel);
    // Address sub-steps mirror the identity layout: a verification
    // checkmark + an "Issuing credential" row whenever there is a
    // credential to track. We surface sub-steps in three cases:
    //
    //   1. `sessionInFlight` — customer is actively in Didit's hosted
    //      address flow on a device. Render an `in_progress` "Verifying
    //      address" row so the stepper communicates active work
    //      (same UX as identity's two pending rows during capture).
    //   2. Mint window — Didit returned `approved`, on-chain commit
    //      in flight. Render an `Address verified` ✓ row + the
    //      `Issuing Enhanced credential` row.
    //   3. Neither — render zero sub-steps so a `completed` parent
    //      doesn't sprout a redundant green "Address verified" line.
    const inMintWindow = state.mintProgress !== null;
    if (!inMintWindow && !state.sessionInFlight) {
      return Object.freeze([] as readonly PhaseSubStep[]);
    }

    if (!inMintWindow) {
      // In-flight capture branch — single in_progress row. No mint
      // sub-step yet (Didit hasn't approved); rendering one would lie
      // about state.
      return Object.freeze([
        Object.freeze({
          label: 'Verifying address',
          status: 'in_progress' as const,
        }),
      ]);
    }

    const addressDone = inMintWindow || rank >= LEVEL_RANK.kyc_4;

    return Object.freeze([
      Object.freeze({
        label: addressDone ? 'Address verified' : 'Address review',
        status: addressDone ? ('completed' as const) : ('pending' as const),
      }),
      Object.freeze({
        label:
          state.mintProgress!.state === 'failed'
            ? `Enhanced credential issuance failed (attempt ${state.mintProgress!.attempts} of ${state.mintProgress!.totalAttempts})`
            : state.mintProgress!.state === 'retrying'
              ? `Retrying credential issuance — attempt ${state.mintProgress!.attempts} of ${state.mintProgress!.totalAttempts}`
              : 'Issuing Enhanced credential on Sepolia…',
        status:
          state.mintProgress!.state === 'failed'
            ? ('failed' as const)
            : state.mintProgress!.state === 'completed'
              ? ('completed' as const)
              : ('in_progress' as const),
      }),
    ]);
  },
  resolveCallbackVariant: diditSessionStatusToCallbackVariant,
});

function resolveNftMintStepStatus(state: PhaseStateInput): StepStatus {
  const rank = rankCustomerKycLevel(state.customerKycLevel);
  if (rank < LEVEL_RANK.kyc_4) return 'locked';
  if (state.nftContractId === null) return 'active';
  return 'completed';
}

const NFT_MINT: PhaseDefinition = Object.freeze({
  id: 'nft_mint' as const,
  stepLabel: 'Soulbound NFT',
  diditWorkflow: null,
  startEndpoint: null,
  opensAtLevel: 'kyc_4' as const,
  completesAtLevel: null,
  // Mint is opened from POST /api/customer/credential/mint-nft, not
  // a kyc/start-* endpoint. The eligibility array stays empty so a
  // misuse (handler dispatching off this entry) fails loud.
  eligibleStartLevels: Object.freeze([] as readonly CustomerKycLevel[]),
  satisfiesScopeLevel: null,
  supportsHandoff: false,
  defaultsToHandoff: false,
  // Mint is on-chain (chain); reconciler covers it via a different
  // pipeline (credential-pipeline-worker stuck-mint detection — see
  // S9-Faz1.5). Excluded from Didit-driven drift handlers.
  supportsForwardDriftReconciliation: false,
  supportsReverseDriftReconciliation: false,
  describe(state: PhaseStateInput): string {
    const status = resolveNftMintStepStatus(state);
    if (status === 'completed') {
      return 'Soulbound NFT minted on Sepolia. Burns automatically on revoke.';
    }
    if (status === 'active') {
      return 'Pick a card theme below and mint your Soulbound NFT on Sepolia.';
    }
    return 'Mint your Soulbound NFT on Sepolia once your address is verified.';
  },
  resolveStepStatus: resolveNftMintStepStatus,
  resolveCallbackVariant: null,
});

/**
 * Ordered phase list — iteration order = stepper order.
 * Adding a phase: append here, add the definition above.
 */
export const KYC_PHASES: readonly PhaseDefinition[] = Object.freeze([
  IDENTITY,
  ADDRESS,
  NFT_MINT,
]);

/**
 * Direct exports for handler/test sites that want a specific phase
 * without going through the lookup helper. Prefer these over a
 * dynamic `getPhase('identity')` when the call site is statically
 * tied to a single phase — TS catches typos at the import site
 * instead of at the lookup call.
 */
export const IDENTITY_PHASE = IDENTITY;
export const ADDRESS_PHASE = ADDRESS;
export const NFT_MINT_PHASE = NFT_MINT;

/** Lookup by id (compile-time exhaustive). */
const PHASE_BY_ID: Readonly<Record<KycPhaseId, PhaseDefinition>> = Object.freeze({
  identity: IDENTITY,
  address: ADDRESS,
  nft_mint: NFT_MINT,
});

/** Lookup helper. Throws on unknown id (TS already excludes that, but defends a `string` upcast). */
export function getPhase(id: KycPhaseId): PhaseDefinition {
  const phase = PHASE_BY_ID[id];
  if (phase === undefined) {
    throw new Error(`Unknown KYC phase id: ${id}`);
  }
  return phase;
}

/* ------------------------------------------------------------------ */
/*  Phase selection — one place, every caller                         */
/* ------------------------------------------------------------------ */

/**
 * Pick the next Didit-driven phase the customer should run. Returns
 * `null` if every Didit phase is already completed (the customer is
 * at `kyc_4`).
 *
 * Used by:
 *   * `/api/customer/kyc/start-from-consent` — picks identity vs
 *     address based on credential level.
 *   * Reconciler — knows which workflow to poll for a given level.
 *
 * Linear progression assumption: identity must complete before
 * address. If a future phase splits or interleaves, this is the
 * function that needs updating, not its callers.
 */
export function nextDiditPhase(level: CustomerKycLevel): PhaseDefinition | null {
  const rank = rankCustomerKycLevel(level);
  for (const phase of KYC_PHASES) {
    if (phase.diditWorkflow === null) continue;
    if (phase.completesAtLevel === null) continue;
    if (rank < rankCustomerKycLevel(phase.completesAtLevel)) {
      return phase;
    }
  }
  return null;
}

/**
 * Locate the phase that a given Didit workflow value corresponds to.
 * Used by the callback-status endpoint and the reconciler to map
 * `kyc_sessions.workflow` → registry entry.
 */
export function findPhaseByDiditWorkflow(
  workflow: 'identity' | 'address' | string | null,
): PhaseDefinition | null {
  if (workflow === null) return null;
  for (const phase of KYC_PHASES) {
    if (phase.diditWorkflow === workflow) return phase;
  }
  return null;
}

/**
 * Convenience: ordered list of Didit-driven phases (excludes the
 * mint phase). Reconciler iterates this when scoping its drift
 * queries.
 */
export const DIDIT_DRIVEN_PHASES: readonly PhaseDefinition[] = Object.freeze(
  KYC_PHASES.filter((p) => p.diditWorkflow !== null),
);
