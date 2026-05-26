'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { KycStepper, type KycStep } from '@/components/customer/kyc-stepper';
import { ChainBranch, type ChainBranchEvent } from '@/components/customer/chain-branch';
import { NftThemePicker } from '@/components/customer/nft-theme-picker';
import { KycActionPanel } from '@/components/customer/kyc-action-panel';
import { ScoreRing } from '@/components/customer/score-ring';
import { LevelBadge } from '@/components/customer/level-badge';
import { useKycStatus, type KycSession, type KycMintProgressMap } from '@/hooks/use-kyc-status';
import { useKycEvents } from '@/hooks/use-kyc-events';
import { isActiveSessionStatus } from '@/lib/kyc/session-status-display';
import {
  ADDRESS_PHASE,
  IDENTITY_PHASE,
  KYC_PHASES,
  NFT_MINT_PHASE,
  nextDiditPhase,
  type CustomerKycLevel,
  type KycPhaseId,
  type PhaseStateInput,
  isCustomerKycLevel,
} from '@/lib/kyc/phase-registry';
import type { KycStatus } from '@crivacy/shared-types';

/**
 * Accept only same-origin, single-slash-prefixed paths as a continue
 * target. Rejects `//evil.com` (protocol-relative open redirect),
 * absolute URLs, and anything without a leading slash. Same rule the
 * login page applies to its `from=` parameter.
 */
function safeContinuePath(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw.length === 0) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  return raw;
}

/* -------------------------------------------------------------------------- */
/*  Step model, registry-driven (Sprint 9)                                   */
/* -------------------------------------------------------------------------- */

interface BuildStepsArgs {
  readonly customerKycLevel: CustomerKycLevel;
  readonly identityInReview: boolean;
  readonly addressInReview: boolean;
  /**
   * `true` when the workflow's most recent `kyc_sessions` row is in
   * `pending` / `in_progress`, i.e. the customer is actively inside
   * Didit's hosted capture flow on some device right now. Drives the
   * sub-step `in_progress` (animated theme-accent) rows so the stepper
   * shows live work instead of grey "pending" while a phone is
   * mid-capture.
   */
  readonly identityInFlight: boolean;
  readonly addressInFlight: boolean;
  readonly nftContractId: string | null;
  /**
   * Per-phase chain mint state. Surfaced from `/api/customer/kyc/status`;
   * non-null only inside the gap between Didit-approved decision and
   * the on-chain commit landing in `kyc_credentials_meta`. Drives
   * the registry's `minting` / `failed` step status path so the
   * stepper does not falsely show an "active, Start verification"
   * CTA after Didit approved while the worker is still committing.
   */
  readonly mintProgress: KycMintProgressMap;
  /** React node to mount inside a phase's step row. Keyed by phase id. */
  readonly actionSlots: Partial<Record<KycPhaseId, React.ReactNode>>;
}

/**
 * Truncate a on-chain contract id for inline display (first 6 + ellipsis +
 * last 4). Mirrors the helper used by `chain-branch.tsx` so the NFT step
 * description renders the same shape the chain panel uses elsewhere.
 */
function truncateContractIdShort(cid: string): string {
  if (cid.length <= 14) return cid;
  return `${cid.slice(0, 6)}…${cid.slice(-4)}`;
}

/**
 * Build the stepper data from the phase registry. The stepper has
 * one UI-only "Create Account" entry that is not a phase (it is
 * always completed for any customer that has reached this page),
 * followed by every phase from `KYC_PHASES` in registry order.
 *
 * Per-phase status, description, and sub-step rows come from the
 * registry resolvers, the page does not know about level
 * thresholds. The only page-side enrichment is the completed-mint
 * description, which embeds a `<Link>` to `/credential` plus the
 * truncated contract id; that is presentation, not state, and so
 * stays out of the registry.
 */
function buildSteps(args: BuildStepsArgs): KycStep[] {
  const {
    customerKycLevel,
    identityInReview,
    addressInReview,
    identityInFlight,
    addressInFlight,
    nftContractId,
    mintProgress,
    actionSlots,
  } = args;

  // 'register' step, UI-only. Not a registry phase (no Didit
  // workflow, no level transition, no callback). Always completed
  // because every customer that lands on /kyc has cleared the
  // post-registration gate.
  const registerStep: KycStep = {
    id: 'register',
    label: 'Create Account',
    description: 'Account created and ready for verification.',
    status: 'completed',
  };

  const phaseSteps = KYC_PHASES.map((phase): KycStep => {
    // Per-phase `inReview` signal. Only identity + address have a
    // session-derived in-review state (Didit returned `in_review`
    // or `resubmission_pending`); the mint phase has no session and
    // therefore no in-review concept.
    const inReview =
      phase.id === 'identity'
        ? identityInReview
        : phase.id === 'address'
          ? addressInReview
          : false;

    // Pick the per-phase mint progress (null for phases without a
    // chain mint, only nft_mint is excluded today). Identity reads
    // from `mintProgress.identity`; address from `mintProgress.address`.
    // The mint phase has no entry because its on-chain artefact is
    // tracked via `nftContractId` on a separate code path.
    const phaseMintProgress =
      phase.id === 'identity'
        ? mintProgress.identity
        : phase.id === 'address'
          ? mintProgress.address
          : null;

    // Per-phase in-flight signal. Identity reads from `identityInFlight`,
    // address from `addressInFlight`; the mint phase has no Didit
    // session and therefore no in-flight concept (mint progress is
    // tracked separately via `mintProgress`).
    const phaseInFlight =
      phase.id === 'identity'
        ? identityInFlight
        : phase.id === 'address'
          ? addressInFlight
          : false;

    const state: PhaseStateInput = {
      customerKycLevel,
      // The stepper status doesn't need the active-session flag (the
      // active-session check drives the action slot, not step
      // colouring), so we hand the resolver a stable `false`. The
      // session presence is reflected in the slot, not the status.
      hasActiveSession: false,
      inReview,
      sessionInFlight: phaseInFlight,
      nftContractId,
      mintProgress: phaseMintProgress,
    };

    const status = phase.resolveStepStatus(state);
    const slot = actionSlots[phase.id];

    // The mint phase's completed description carries an inline link
    // to /credential plus the truncated contract id, a presentation
    // concern that stays out of the registry. Other phases use the
    // canonical string the registry returns.
    const description: React.ReactNode =
      phase.id === 'nft_mint' && status === 'completed' && nftContractId !== null ? (
        <>
          <Link
            href="/credential"
            className="font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
            title="View your soulbound NFT"
          >
            Soulbound NFT minted · {truncateContractIdShort(nftContractId)}
          </Link>
          {' - burns automatically on revoke.'}
        </>
      ) : (
        phase.describe(state)
      );

    // Action slot suppression rules:
    //   - `completed`, identity collapses to a "verified" line; the
    //      address/mint phases keep their slot (mint phase wants the
    //      theme-picker, address renders a "verified" panel).
    //   - `minting`, Didit said done, on-chain commit in flight.
    //      No actionable button while the worker is committing; the
    //      animated sub-step row carries the live signal.
    //   - `failed`, retries exhausted. Hide the start CTA and let
    //      the description copy point the customer at support.
    const slotAllowedForStatus = status !== 'minting' && status !== 'failed';
    const showSlot =
      slotAllowedForStatus && (phase.id === 'identity' ? status !== 'completed' : true);
    const extraContent = showSlot && slot !== undefined ? slot : undefined;

    // Phase id `nft_mint` is normalised to the existing wire id
    // `nft-mint` to avoid touching every kyc-stepper test fixture
    // and analytics tag that already keys on the hyphenated form.
    const stepId = phase.id === 'nft_mint' ? 'nft-mint' : phase.id;

    const step: KycStep = {
      id: stepId,
      label: phase.stepLabel,
      description,
      status,
      ...(phase.subSteps !== undefined ? { subSteps: phase.subSteps(state) } : {}),
      ...(extraContent !== undefined ? { extraContent } : {}),
    };
    return step;
  });

  return [registerStep, ...phaseSteps];
}

/**
 * Pretty-print a Didit feature node id for the resubmission banner.
 * Didit's `nodes_to_resubmit[].feature` ships uppercase enum-style
 * strings (`OCR`, `LIVENESS`, `FACE_MATCH`, `POA`, …); the customer
 * UI gets a human-readable form. Falls back to a title-case of the
 * raw value for any feature we have not mapped explicitly so a future
 * Didit feature does not render as a blank space.
 */
function formatFeatureLabel(feature: string): string {
  const map: Readonly<Record<string, string>> = {
    OCR: 'document photo',
    LIVENESS: 'liveness check',
    FACE_MATCH: 'face match',
    NFC: 'document chip read',
    POA: 'proof of address',
    PHONE: 'phone verification',
    EMAIL: 'email verification',
    AML: 'compliance screening',
    DATABASE_VALIDATION: 'database validation',
    IP_ANALYSIS: 'IP analysis',
    QUESTIONNAIRE: 'questionnaire',
    AGE_ESTIMATION: 'age estimation',
  };
  if (feature in map) return map[feature]!;
  return feature
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/*  Chain event derivation                                                    */
/* -------------------------------------------------------------------------- */

interface ActiveCredentialShape {
  readonly chainContractId?: string | null;
  readonly chainNetwork?: string | null;
  readonly level?: string | null;
  readonly status?: string | null;
}

function extractActiveCredential(raw: unknown): ActiveCredentialShape | null {
  if (raw === null || typeof raw !== 'object') return null;
  return raw as ActiveCredentialShape;
}

interface ChainEventInputs {
  /**
   * Identity phase status, drives the "Basic credential issued" chip.
   * Sourced from `IDENTITY_PHASE.resolveStepStatus()` so the threshold
   * for "Basic credential present" matches the registry's
   * `completesAtLevel` exactly.
   */
  readonly identityStatus: 'locked' | 'active' | 'in_review' | 'minting' | 'completed' | 'failed';
  /**
   * Address phase status, drives the "Enhanced credential issued" chip.
   * Sourced from `ADDRESS_PHASE.resolveStepStatus()`; when this is
   * `completed`, the basic credential is implicitly superseded and
   * the chip set collapses to the Enhanced one.
   */
  readonly addressStatus: 'locked' | 'active' | 'in_review' | 'minting' | 'completed' | 'failed';
  readonly activeCredential: ActiveCredentialShape | null;
}

/**
 * Build the chain-event chip list shown next to the stepper. Note: the
 * "Soulbound NFT minted" chip was retired 2026-05-02 and absorbed by
 * stepper step 4, surfacing it both there and here was duplicate
 * information. The chain branch now scopes to credential-level events
 * (Basic / Enhanced) only.
 *
 * Sprint 9: thresholds come from registry-resolved phase statuses
 * instead of `levelNum >= N` magic numbers, so a future level
 * re-numbering only touches the registry.
 */
function deriveChainEvents({
  identityStatus,
  addressStatus,
  activeCredential,
}: ChainEventInputs): ChainBranchEvent[] {
  const events: ChainBranchEvent[] = [];

  if (
    identityStatus === 'completed' &&
    addressStatus !== 'completed' &&
    activeCredential?.chainContractId
  ) {
    // Phase 1 only, Basic credential, no Enhanced yet.
    events.push({
      id: 'basic',
      label: 'Basic credential issued',
      contractId: activeCredential.chainContractId,
      tone: 'success',
    });
  }

  if (addressStatus === 'completed' && activeCredential?.chainContractId) {
    // Phase 2 finalised, old Basic was superseded, Enhanced is the
    // active row. We surface a single "Enhanced credential issued"
    // chip; the supersede event is implied (customer doesn't need to
    // see the archived Basic row).
    events.push({
      id: 'enhanced',
      label: 'Enhanced credential issued',
      contractId: activeCredential.chainContractId,
      tone: 'success',
    });
  }

  return events;
}

/* -------------------------------------------------------------------------- */
/*  Content skeleton (header always renders static, sektör pattern)          */
/* -------------------------------------------------------------------------- */

function KycContentSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Skeleton className="h-64" />
      <Skeleton className="col-span-2 h-96" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Active session resolver                                                   */
/* -------------------------------------------------------------------------- */

function pickActiveSession(sessions: readonly KycSession[]): KycSession | null {
  return (
    sessions.find((s) => ['pending', 'in_progress'].includes(s.status) && s.redirectUrl) ?? null
  );
}

function isSessionInReview(
  sessions: readonly KycSession[],
  workflow: 'identity' | 'address',
): boolean {
  return sessions.some((s) => s.workflow === workflow && ['identity_approved'].includes(s.status));
}

/**
 * Find the most recent rejected session for a workflow when it's
 * the customer's most recent session for that workflow AND no
 * active session exists. Returns null when:
 *
 *  - the customer has no rejected session for this workflow
 *  - the rejected session is older than a more recent non-rejected
 *    one (e.g. they retried and the new attempt is pending), that
 *    pending session is the right thing to show, not the prior
 *    decline
 *
 * Used to render the "verification declined" banner only when it
 * accurately describes the *current* state. Sessions are pre-sorted
 * by `createdAt desc` server-side so the first match is the most
 * recent.
 */
function findRecentDecline(
  sessions: readonly KycSession[],
  workflow: 'identity' | 'address',
): KycSession | null {
  const latest = sessions.find((s) => s.workflow === workflow);
  if (latest === undefined) return null;
  return latest.status === 'rejected' ? latest : null;
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * KYC overview page.
 *
 * Layout:
 *   - Left card: score ring + level badge.
 *   - Right card: chain-event branch (left col) + 3-step vertical
 *     stepper (right col). Step 3 (Address) shows the action button +
 *     NFT preview card while it is the active step; once the credential
 *     is minted the chain branch picks up the chips and step 3
 *     collapses to a "Verified" line.
 */
export default function KycOverviewPage() {
  const { status, isLoading, mutate } = useKycStatus();
  const [starting, setStarting] = React.useState(false);
  const searchParams = useSearchParams();
  const continuePath = safeContinuePath((searchParams?.get('continue') ?? null));

  /**
   * The KYC session id whose handoff token has been consumed on a
   * mobile device. Set by the `kyc.handoff_consumed` SSE event so the
   * desktop UI can swap the QR card for a "verification opened on
   * your phone, continue there" panel, matching the Stripe Identity
   * / Persona / Onfido cross-device handoff UX. Cleared when the
   * session leaves a pending/in_progress state (terminal status
   * change), since at that point the desktop should advance to the
   * next step rather than keep the phone-active panel.
   */
  const [phoneActiveSessionId, setPhoneActiveSessionId] =
    React.useState<string | null>(null);

  // Revalidate on every SSE event; record the phone-active session id
  // on `kyc.handoff_consumed`. Clearing the id is intentionally NOT
  // driven off the SSE payload, that path races the SWR refetch (the
  // setter fires sync, the mutate is async). In the gap between the
  // two, `phoneActive` was `false` but `mode` was still `'continue'`
  // and `handoffMode` was still `'auto'`, so `KycActionPanel` briefly
  // re-rendered `<HandoffSubsection>` and its mount effect fired
  // `generateHandoff`, POSTing the start endpoint and silently
  // creating a fresh kyc_session row mid-transition.
  //
  // The clear is now derived from SWR data (see `phoneActive` below):
  // it flips to `false` only after the SWR refetch lands the new
  // session status, so there is no intermediate render where the
  // panel can stage an unwanted re-mount. Same SoT (session.status)
  // drives both the panel mount logic and the phone-active flag.
  useKycEvents(
    React.useCallback((event, data) => {
      if (event === 'kyc.handoff_consumed') {
        const payload = data as { readonly sessionId?: unknown } | null;
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
        if (sessionId !== null) {
          setPhoneActiveSessionId(sessionId);
        }
      }
      void mutate();
    }, [mutate]),
  );

  const kycLevel = status?.kycLevel ?? 'kyc_0';
  const kycScore = status?.kycScore ?? 0;
  const levelName = status?.levelName ?? 'Unverified';
  const maxScore = status?.maxScore ?? 1000;
  const sessions = status?.sessions ?? [];
  // Didit-revoke signal (Batch E). Set when Didit deleted/blocked the
  // customer's user-entity. Drives a top-level banner + disables the
  // start-session CTAs (server returns 409 anyway, but disabling the
  // button avoids a confusing round-trip).
  const revokedAt = status?.revokedAt ?? null;
  // Wallet-link gate. A credential is keyed by (and only decryptable
  // with) the customer's own EVM wallet, so verification cannot start
  // until a wallet is linked. Mirrors the server-side `wallet_not_linked`
  // 409 in the start handlers, disabling the CTA avoids a confusing
  // round-trip. Defaults to `false` while status is loading so we never
  // briefly enable the CTA for a wallet-less customer.
  const hasWallet = status?.hasWallet ?? false;
  const activeCredential = extractActiveCredential(status?.activeCredential ?? null);
  // NFT mint state is sourced from the kyc/status response (single DB
  // lookup, no chain RPC) so Step 4 never flashes "Minting…" while a
  // separate /credential fetch is still in flight. The /credential
  // endpoint is reserved for the rich on-chain artefact (image, serial,
  // displayName) which only the dedicated NFT page renders.
  const nftContractId = status?.nftContractId ?? null;

  // `isActiveSessionStatus` (lib/kyc/session-status-display) is the
  // shared predicate, it includes `pending | in_progress | in_review
  // | resubmission_pending | identity_approved | address_in_progress`
  // and intentionally excludes `kyc_expired` (re-verification needs a
  // fresh session). Any future status addition flows through the
  // helper, so the customer/admin/dashboard surfaces all stay in sync
  // automatically.
  const hasActiveIdentitySession = sessions.some(
    (s) => s.workflow === 'identity' && isActiveSessionStatus(s.status as KycStatus),
  );
  const hasActiveAddressSession = sessions.some(
    (s) => s.workflow === 'address' && isActiveSessionStatus(s.status as KycStatus),
  );

  // Workflow-scoped "actively in Didit hosted capture flow" predicate.
  // Distinct from `hasActive*Session`: that broader predicate covers
  // `in_review` / `identity_approved` / `resubmission_pending` (states
  // where Didit has the decision and the customer is no longer in a
  // device capture flow). `*InFlight` is the narrower "right now,
  // some device is mid-capture" signal, drives the sub-step
  // `in_progress` (animated theme-accent) rows so the stepper shows
  // live work while a phone is scanning the document / capturing
  // liveness / uploading the address proof.
  const identityInFlight = sessions.some(
    (s) =>
      s.workflow === 'identity' && (s.status === 'pending' || s.status === 'in_progress'),
  );
  const addressInFlight = sessions.some(
    (s) =>
      s.workflow === 'address' && (s.status === 'pending' || s.status === 'in_progress'),
  );

  // Top-level state banners.
  const inReviewSessions = sessions.filter((s) => s.status === 'in_review');
  const resubmissionSessions = sessions.filter((s) => s.status === 'resubmission_pending');
  const kycExpiredSessions = sessions.filter((s) => s.status === 'kyc_expired');

  // Recent decline detection (per workflow). Surfaces the failure
  // reason in an explicit "verification declined" pane on the
  // relevant step instead of leaving the user staring at an
  // unchanged Start button after Didit said no. The signal is
  // workflow-scoped so an identity decline doesn't sit underneath an
  // active address attempt and vice versa.
  const recentIdentityDecline = findRecentDecline(sessions, 'identity');
  const recentAddressDecline = findRecentDecline(sessions, 'address');

  // Per-customer cooldown (Plan B backend gate). When `locked` the
  // start endpoints already 429 the request; the UI mirrors that
  // here by disabling the start CTAs and surfacing a countdown so
  // the customer doesn't refresh-spam the gate.
  const declineLock = status?.declineLock ?? null;

  const identityInReview = isSessionInReview(sessions, 'identity');
  const addressInReview = isSessionInReview(sessions, 'address');

  // Sprint 9: every level threshold is derived through the phase
  // registry resolvers, `levelNum` magic numbers were a duplicate
  // of the same predicates the registry already exposes. Adding a
  // future phase = adding a registry entry; this surface picks up
  // automatically.
  const customerKycLevelTyped: CustomerKycLevel = isCustomerKycLevel(kycLevel)
    ? kycLevel
    : 'kyc_0';
  // Per-phase state. Each phase reads its own mint progress slot from
  // `/api/customer/kyc/status` so the chain-event chip + canReturn
  // gate respect the in-flight mint window the same way the stepper
  // does (no chain chip while mint is still committing, the parent
  // step shows the animated `minting` marker instead).
  const identityPhaseState: PhaseStateInput = {
    customerKycLevel: customerKycLevelTyped,
    hasActiveSession: false,
    inReview: false,
    sessionInFlight: identityInFlight,
    nftContractId,
    mintProgress: status?.mintProgress.identity ?? null,
  };
  const addressPhaseState: PhaseStateInput = {
    customerKycLevel: customerKycLevelTyped,
    hasActiveSession: false,
    inReview: false,
    sessionInFlight: addressInFlight,
    nftContractId,
    mintProgress: status?.mintProgress.address ?? null,
  };
  const mintPhaseState: PhaseStateInput = {
    customerKycLevel: customerKycLevelTyped,
    hasActiveSession: false,
    inReview: false,
    sessionInFlight: false,
    nftContractId,
    mintProgress: null,
  };
  const identityStatus = IDENTITY_PHASE.resolveStepStatus(identityPhaseState);
  const addressStatus = ADDRESS_PHASE.resolveStepStatus(addressPhaseState);
  const mintStatus = NFT_MINT_PHASE.resolveStepStatus(mintPhaseState);
  const allDiditPhasesDone = nextDiditPhase(customerKycLevelTyped) === null;

  const canStartIdentity =
    hasWallet &&
    IDENTITY_PHASE.eligibleStartLevels.includes(customerKycLevelTyped) &&
    !hasActiveIdentitySession;
  const canStartAddress =
    hasWallet &&
    ADDRESS_PHASE.eligibleStartLevels.includes(customerKycLevelTyped) &&
    !hasActiveAddressSession;
  const activeSession = pickActiveSession(sessions);

  const chainEvents = deriveChainEvents({
    identityStatus,
    addressStatus,
    activeCredential,
  });

  /* ---------------------------------------------------------------------- */
  /*  Start-verification handlers                                           */
  /* ---------------------------------------------------------------------- */

  async function handleStartVerification(endpoint: string) {
    setStarting(true);
    try {
      // Sprint 9 `continueUrl` threading: when /kyc was reached
      // mid-OAuth (`/kyc?continue=/oauth/consent?request=...`),
      // forward that target so the new session row carries it
      // through to `/kyc/callback`. The handler same-origin guards
      // it server-side, so a tampered `?continue=` value just
      // becomes null. Empty body when the page wasn't entered with
      // a continue param.
      const body = continuePath !== null ? { continueUrl: continuePath } : null;
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        ...(body !== null
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        const message = (err?.['message'] as string | undefined) ?? 'Failed to start verification.';
        alert(message);
        return;
      }
      const data = (await res.json()) as {
        readonly sessionId: string;
        readonly redirectUrl: string;
      };
      window.location.href = data.redirectUrl;
    } catch {
      alert('Network error. Please try again.');
    } finally {
      setStarting(false);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Per-step action slots                                                 */
  /* ---------------------------------------------------------------------- */

  // Each step renders its own action button inside the stepper so the
  // CTA stays anchored to the relevant step semantically. Only one
  // step is "current" at a time, so at most one action slot is non-null.

  // Sprint 10: identity AND address action slots both render the
  // unified `KycActionPanel`. The panel is registry-driven, the
  // phase entry decides label, start endpoint, and whether to
  // surface the QR sub-section (`supportsHandoff`). The legacy
  // address slot was a plain `<Button>` that bypassed the
  // camera/handoff/phone-active machinery identity already had,
  // which made the cross-device address flow impossible. With both
  // phases on the same panel the whole UX surface stays in one place
  // and a future phase addition (or copy tweak) reaches both.
  function buildPhaseActionSlot(args: {
    readonly phase: typeof IDENTITY_PHASE | typeof ADDRESS_PHASE;
    readonly status: 'locked' | 'active' | 'in_review' | 'minting' | 'completed' | 'failed';
    readonly canStart: boolean;
    readonly inReview: boolean;
    readonly workflow: 'identity' | 'address';
    readonly recentDecline: KycSession | null;
  }): React.ReactNode {
    const { phase, status, canStart, inReview, workflow, recentDecline } = args;
    if (status === 'completed') return null;
    const phaseSession = activeSession?.workflow === workflow ? activeSession : null;
    // Anchor the phone-active panel to the specific session id so a
    // stale handoff_consumed event from a session the user has since
    // cancelled / replaced cannot lock a fresh session into the
    // phone-active panel.
    const phoneActive =
      phoneActiveSessionId !== null &&
      phaseSession !== null &&
      phaseSession.id === phoneActiveSessionId;
    if (phaseSession !== null) {
      return (
        <KycActionPanel
          // Stable per-workflow key. Earlier the key was
          // `${workflow}-${mode}` so a `start -> continue` flip would
          // unmount/remount the panel, that wiped the QR mid-display
          // (the QR sub-section creates the kyc_session row, the SSE
          // refresh flips `mode` from `start` to `continue`, the key
          // change unmounts the panel before the customer scans).
          // The "stale handoffMode after decline" protection that
          // motivated the per-mode key is now handled by an internal
          // direction-aware reset inside `KycActionPanel`.
          key={`${workflow}-panel`}
          phase={phase}
          mode="continue"
          starting={starting}
          continueUrl={phaseSession.redirectUrl}
          phoneActive={phoneActive}
          continuePath={continuePath}
          cooldown={declineLock}
        />
      );
    }
    if (canStart && !inReview) {
      // Decline payload (Plan A). Pass the failureReason +
      // attempts only when this phase has a current-state recent
      // decline; null for first-time customers / customers whose
      // last attempt is still in flight. The panel uses null to
      // decide between "Start" and "Try again" copy AND whether
      // to render the declined banner.
      const declinePayload =
        recentDecline !== null
          ? {
              failureReason: recentDecline.failureReason,
              attempts: recentDecline.attempts,
            }
          : null;
      return (
        <KycActionPanel
          // Same stable per-workflow key as the `continue` branch —
          // see comment above for why the per-mode keying was retired.
          key={`${workflow}-panel`}
          phase={phase}
          mode="start"
          starting={starting}
          onStartDesktop={async () => {
            // `phase.startEndpoint` is `null` only for the mint
            // phase, which never reaches this branch (its slot is
            // built separately below).
            if (phase.startEndpoint === null) return;
            await handleStartVerification(phase.startEndpoint);
          }}
          phoneActive={false}
          continuePath={continuePath}
          recentDecline={declinePayload}
          cooldown={declineLock}
        />
      );
    }
    return null;
  }

  const identityActionSlot = buildPhaseActionSlot({
    phase: IDENTITY_PHASE,
    status: identityStatus,
    canStart: canStartIdentity,
    inReview: identityInReview,
    workflow: 'identity',
    recentDecline: recentIdentityDecline,
  });

  const addressActionSlot = buildPhaseActionSlot({
    phase: ADDRESS_PHASE,
    status: addressStatus,
    canStart: canStartAddress,
    inReview: addressInReview,
    workflow: 'address',
    recentDecline: recentAddressDecline,
  });

  // Step 4 extra-content rendering. After the 2026-05-07 manual-mint
  // refactor:
  //
  //   - `nftContractId !== null` (minted) → null. The description
  //      line carries the link + truncated contract id; the showcase
  //      lives on the dedicated /credential route.
  //   - `nftContractId === null` → live theme picker. Renders at
  //      every step (so the customer can browse light/dark previews
  //      from the start of the journey), with `canMint` gating the
  //      Mint button on the Enhanced credential being on chain.
  //      Sprint 9: the gate is now `mintStatus === 'active'` from
  //      the registry, equivalent to "address completed AND no NFT
  //      yet", but the threshold lives in one place.
  let mintExtraSlot: React.ReactNode = null;
  if (nftContractId === null) {
    mintExtraSlot = (
      <NftThemePicker
        canMint={mintStatus === 'active'}
        onMintSuccess={() => {
          void mutate();
        }}
      />
    );
  }

  /* ---------------------------------------------------------------------- */
  /*  Steps                                                                 */
  /* ---------------------------------------------------------------------- */

  // Registry-driven step build. Phase status / description / sub-steps
  // all come from `KYC_PHASES` resolvers; only the action React nodes
  // are page-built and threaded in by phase id. `customerKycLevelTyped`
  // is already derived above (see "every level threshold" block) and
  // re-used here so we don't compute the same narrow twice.
  // Per-phase mint progress projection from `/api/customer/kyc/status`.
  // Falls back to an empty `{ identity: null, address: null }` map when
  // the response hasn't loaded yet so the registry sees `null` (no
  // mint window) rather than `undefined` (TS error). The endpoint is
  // already loaded by `useKycStatus` above; this just narrows the
  // shape for the registry input.
  const mintProgressInput: KycMintProgressMap = status?.mintProgress ?? {
    identity: null,
    address: null,
  };

  const steps = buildSteps({
    customerKycLevel: customerKycLevelTyped,
    identityInReview,
    addressInReview,
    identityInFlight,
    addressInFlight,
    nftContractId,
    mintProgress: mintProgressInput,
    actionSlots: {
      identity: identityActionSlot ?? undefined,
      address: addressActionSlot ?? undefined,
      nft_mint: mintExtraSlot ?? undefined,
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  Render                                                                */
  /* ---------------------------------------------------------------------- */

  // When a partner site redirected the user here mid-OAuth flow,
  // `?continue=…` carries the consent page URL. We show a resume
  // banner at the top so the user knows where they'll land once KYC
  // completes, and a "Return now" button that becomes useful once
  // every Didit phase is done (registry: `nextDiditPhase === null`,
  // i.e. the customer is at the highest Didit-driven level). Path
  // is same-origin validated by `safeContinuePath` before we ever
  // render it.
  const hasContinue = continuePath !== null;
  const canReturn = hasContinue && allDiditPhasesDone;

  // The right-hand sidebar shows the customer's earned score
  // throughout the journey, including at completion. Earlier the ring
  // flipped to a generic checkmark and the badge label flipped to
  // "Verified" once the customer hit kyc_4, which hid the score the
  // user worked to earn (e.g. 1000 / 1000) and replaced it with a
  // copy-paste success state identical to other stages. Keep showing
  // the numeric score + raw level name so the score progression stays
  // visible end-to-end. The stepper on the left already communicates
  // "journey complete" via its checkmarks; the sidebar's job is the
  // score itself.
  const displayLevelName = levelName;

  return (
    <div className="space-y-8">
      {/* Header, static, rendered immediately so the user lands on a known
          page even before KYC status resolves. */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-fg)]">Verification</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Complete the verification steps to receive your soulbound KYC credential.
        </p>
      </div>

      {isLoading ? (
        <KycContentSkeleton />
      ) : (
        <>
          {hasContinue && (
            <div className="border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 rounded-[var(--radius-md)] border p-4">
              <p className="text-sm text-[var(--color-fg)]">
                <strong>A partner site is waiting for you to finish verification.</strong>
              </p>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                {canReturn
                  ? 'Your credential is ready. Return to the partner site to approve their request.'
                  : "Complete the steps below - you'll be able to return to the partner once your credential is issued."}
              </p>
              {canReturn && (
                <Button
                  className="mt-3"
                  onClick={() => {
                    window.location.href = continuePath!;
                  }}
                >
                  Return to partner site
                </Button>
              )}
            </div>
          )}

          {inReviewSessions.length > 0 && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 p-4"
            >
              <p className="text-sm text-[var(--color-fg)]">
                <strong>
                  Your{' '}
                  {inReviewSessions.length === 1
                    ? `${inReviewSessions[0]!.workflow} verification is`
                    : 'verifications are'}{' '}
                  under manual review.
                </strong>
              </p>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Our compliance team is reviewing your submission. This typically takes 24-48
                hours. You&apos;ll be notified by email when the review completes, no further
                action is needed from you right now.
              </p>
            </div>
          )}

          {resubmissionSessions.map((session) => {
            const info = session.resubmissionInfo;
            const featureLabels =
              info !== null && info.nodes.length > 0
                ? info.nodes.map((n) => formatFeatureLabel(n.feature))
                : [];
            return (
              <div
                key={session.id}
                role="status"
                aria-live="polite"
                className="rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 p-4"
              >
                <p className="text-sm text-[var(--color-fg)]">
                  <strong>Some verification steps need to be redone.</strong>
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {featureLabels.length > 0
                    ? `Please redo: ${featureLabels.join(', ')}.`
                    : 'Please reopen your verification to continue.'}{' '}
                  Your earlier submissions are saved, only the flagged steps are repeated.
                </p>
                {session.redirectUrl !== null && (
                  <Button
                    className="mt-3"
                    onClick={() => {
                      window.location.href = session.redirectUrl!;
                    }}
                  >
                    Resume verification
                  </Button>
                )}
              </div>
            );
          })}

          {kycExpiredSessions.length > 0 && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-[var(--radius-md)] border border-rose-500/40 bg-rose-500/10 p-4"
            >
              <p className="text-sm text-[var(--color-fg)]">
                <strong>Your verified identity has expired.</strong>
              </p>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Your KYC credential reached its expiration date. To continue using verified
                services and partner integrations, complete a new verification below.
              </p>
            </div>
          )}

          {/* Didit-revoke banner (Batch E). Renders when the
              user-entity webhook flipped `customers.revoked_at` —
              either Didit deleted the user (right-to-be-forgotten,
              operator clean-up) or moved them to BLOCKED. Distinct
              from `kyc_expired` (TTL elapsed): the cause is operator
              action, not a clock. */}
          {revokedAt !== null && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-[var(--radius-md)] border border-rose-500/40 bg-rose-500/10 p-4"
            >
              <p className="text-sm text-[var(--color-fg)]">
                <strong>Your verification was revoked by the identity provider.</strong>
              </p>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Your previous KYC credential is no longer valid. Start a fresh verification
                to continue using verified services. Your account itself is still active.
              </p>
            </div>
          )}

          {/* Wallet-link gate. A credential is issued to, owned by, and
              decryptable only with the customer's own EVM wallet, so
              verification cannot start until a wallet is linked. The
              start CTAs are disabled (server enforces the same 409);
              this banner tells the customer why + where to link. */}
          {status !== null && !hasWallet && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm text-[var(--color-fg)]">
                  <strong>Link a wallet to start verification.</strong>
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  Your KYC credential is issued to and owned by your Ethereum wallet, and only
                  your wallet can decrypt it. Connect a wallet to begin.
                </p>
              </div>
              <a
                href="/settings/security"
                className="inline-flex shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90"
              >
                Connect wallet
              </a>
            </div>
          )}

          <div className="grid items-start gap-6 lg:grid-cols-3">
            {/* Main card, chain branch + stepper (left, takes 2/3) */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Verification Steps</CardTitle>
                <CardDescription>
                  Each completed step is reflected on-chain in the events panel.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {chainEvents.length > 0 ? (
                  <div className="grid gap-6 md:grid-cols-[minmax(0,180px),1fr]">
                    <div className="md:border-r md:border-[var(--color-border)] md:pr-6">
                      <ChainBranch
                        events={chainEvents}
                        chainNetwork={activeCredential?.chainNetwork ?? null}
                      />
                    </div>
                    <div>
                      <KycStepper steps={steps} />
                    </div>
                  </div>
                ) : (
                  <KycStepper steps={steps} />
                )}
              </CardContent>
            </Card>

            {/* Sidebar - score ring + level (right, takes 1/3, doesn't stretch) */}
            <Card className="lg:self-start">
              <CardContent className="flex flex-col items-center gap-4 p-6">
                <ScoreRing score={kycScore} maxScore={maxScore} size={140} />
                <LevelBadge level={kycLevel} levelName={displayLevelName} />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
