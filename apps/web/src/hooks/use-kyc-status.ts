'use client';

import useSWR from 'swr';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface KycResubmissionNode {
  readonly node_id: string;
  readonly feature: string;
}

interface KycResubmissionInfo {
  readonly nodes: readonly KycResubmissionNode[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly requested_at: string;
}

interface KycSession {
  readonly id: string;
  readonly workflow: string;
  readonly status: string;
  readonly redirectUrl: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  /**
   * Populated when Didit flagged a Resubmission against this session.
   * Carries the typed list of steps the user needs to redo + reasons
   * per step. `null` on every session that never received a
   * "Resubmitted" webhook.
   */
  readonly resubmissionInfo: KycResubmissionInfo | null;
  /**
   * Human-readable failure label set by webhook + pull-fallback +
   * reconciler when a session reaches a terminal `rejected` status.
   * `'Declined by Didit'` is the legacy fallback; Sprint 6 surfaces
   * the highest-priority Didit warning text when available
   * (e.g. `'Duplicated face from another approved session'`); face-
   * match cascade overrides set `'face_match_blocked'` /
   * `'fraud_cascade'`. `null` on every non-rejected session.
   */
  readonly failureReason: string | null;
  /** Number of Didit attempts against this session row. */
  readonly attempts: number;
  /** ISO completion timestamp; null until the row reaches a terminal status. */
  readonly completedAt: string | null;
  /** ISO start timestamp. */
  readonly startedAt: string;
}

interface KycDeclineLock {
  /** True while the per-customer cooldown window is active. */
  readonly locked: boolean;
  /** Running count of consecutive Didit declines since last approval. */
  readonly count: number;
  /** Threshold that flips `locked` to true (echoes server env knob). */
  readonly threshold: number;
  /** ISO timestamp the cooldown window ends; null when not locked. */
  readonly cooldownEndsAt: string | null;
}

/**
 * Per-phase chain mint progress, mirrors the
 * `MintProgress` type from `lib/kyc/phase-registry`. Wire shape is
 * identical to the server-side projector. `null` outside the mint
 * window (Didit not yet positive, or commit already landed). When
 * non-null, the stepper renders a `minting` / `failed` parent
 * marker plus an animated "Issuing credential" sub-step keyed off
 * `state` + `attempts`.
 */
interface KycMintProgress {
  readonly state: 'pending' | 'retrying' | 'completed' | 'failed';
  readonly attempts: number;
  readonly totalAttempts: number;
}

interface KycMintProgressMap {
  readonly identity: KycMintProgress | null;
  readonly address: KycMintProgress | null;
}

interface ActiveCredentialSummary {
  readonly chainContractId: string | null;
  readonly chainNetwork: string | null;
  readonly level: string | null;
  readonly status: string | null;
}

interface KycStatusData {
  readonly kycLevel: string;
  readonly kycScore: number;
  readonly levelName: string;
  readonly nextLevel: string | null;
  readonly nextLevelName: string | null;
  readonly maxScore: number;
  /**
   * Whether the customer has a linked EVM wallet. A credential is keyed
   * by (and only decryptable with) the customer's own wallet, so the
   * /kyc start CTAs stay disabled until this is true. The server-side
   * start handlers enforce the same gate (`wallet_not_linked` 409), so a
   * manipulated UI cannot bypass it.
   */
  readonly hasWallet: boolean;
  readonly sessions: readonly KycSession[];
  readonly activeCredential: ActiveCredentialSummary | null;
  /**
   * NFT contract id from `kyc_credentials_meta`. Populated only when the
   * Soulbound NFT has been minted on chain (worker has propagated the
   * contract id) and not yet burned. `null` covers three states:
   *   - customer is below Enhanced (no NFT to mint)
   *   - worker is still minting (genuine "Minting…" window)
   *   - NFT was burned (revoke / supersede)
   * Drives the /kyc Step 4 "Soulbound NFT" status without a second fetch.
   */
  readonly nftContractId: string | null;
  /** ISO timestamp of `nft_minted_at` paired with `nftContractId`. */
  readonly nftMintedAt: string | null;
  /**
   * ISO timestamp set by the user-entity webhook handler (Batch E)
   * when Didit revoked the customer's user — either via delete
   * (`user.data.updated` with `deleted_at`) or via BLOCKED status
   * (`user.status.updated`). Drives a top-level "verification was
   * revoked" banner on /kyc and disables the start-session CTAs.
   * Distinct from the `kyc_expired` session-level state which fires
   * on TTL expiry.
   */
  readonly revokedAt: string | null;
  /**
   * Per-customer decline-counter snapshot. Same evaluator the
   * start-* gate uses, so a `locked === true` here exactly matches
   * a 429 response from the start endpoint. Drives the cooldown
   * banner + countdown on /kyc.
   */
  readonly declineLock: KycDeclineLock;
  /**
   * Per-phase chain mint state. Non-null only inside the gap
   * between Didit-approved decision and the on-chain credential
   * commit landing in `kyc_credentials_meta`. Drives the stepper's
   * `minting` / `failed` parent statuses + the per-attempt sub-step
   * row.
   */
  readonly mintProgress: KycMintProgressMap;
}

/* -------------------------------------------------------------------------- */
/*  Hook                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Session statuses that mean "Didit / the pipeline is still working on
 * this" — i.e. the page should keep refetching to surface the next
 * transition (approval, mint window, verified) without a manual reload.
 * Deliberately EXCLUDES the settled `identity_approved` / `approved`
 * session statuses: those stay set forever once Didit approves, so
 * polling on them alone would never stop. The mint window between
 * approval and the on-chain credential landing is covered by the
 * `mintProgress` check instead (non-null exactly in that gap).
 */
const TRANSITIONAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'in_review',
  'address_in_progress',
  'resubmission_pending',
]);

/**
 * True while the KYC flow is mid-transition and the desktop needs live
 * updates: either Didit is still deciding (working session status) or
 * the credential is being minted on-chain (`mintProgress` non-null).
 *
 * Drives the SWR `refreshInterval` below — the SSE stream only pushes on
 * SESSION-status changes, so the credential mint (which bumps the
 * customer level + credential row, NOT the session) never reaches the
 * page over SSE. This short poll fills that gap so "Issuing credential
 * on Sepolia…" and the final verified state appear live instead of
 * requiring a tab refocus / reload.
 */
function isKycTransitional(d: KycStatusData | undefined): boolean {
  if (d === undefined) return false;
  if (d.mintProgress.identity !== null || d.mintProgress.address !== null) {
    return true;
  }
  return d.sessions.some((s) => TRANSITIONAL_SESSION_STATUSES.has(s.status));
}

/** Poll cadence while a transition is in flight. */
const TRANSITIONAL_REFRESH_MS = 2500;

/**
 * SWR hook for the customer's current KYC status.
 * Fetches from `/api/customer/kyc/status` with cookie-based auth.
 *
 * Returns:
 * - `status`    — the parsed response, or `null` while loading / on error.
 * - `error`     — the fetch error, if any.
 * - `isLoading` — `true` on the first request before any data is available.
 * - `mutate`    — bound mutate to force revalidation.
 */
export function useKycStatus() {
  const { data, error, isLoading, mutate } = useSWR<KycStatusData>(
    '/api/customer/kyc/status',
    // Poll only while a transition is in flight; drop to 0 (no polling)
    // once the flow is settled so an idle /kyc tab makes no requests.
    {
      refreshInterval: (latest) =>
        isKycTransitional(latest) ? TRANSITIONAL_REFRESH_MS : 0,
    },
  );

  return {
    status: data ?? null,
    error,
    isLoading,
    mutate,
  } as const;
}

export type { KycSession, KycDeclineLock, KycMintProgress, KycMintProgressMap, KycStatusData };
