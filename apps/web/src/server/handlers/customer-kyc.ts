/**
 * Customer KYC handlers — drive the Didit verification flow from
 * the customer dashboard.
 *
 * Each exported function takes a `CustomerContext` (built by
 * `customerRoute`) and returns a `NextResponse` (or raw `Response`
 * for SSE). The route files in `app/api/customer/kyc/` wire these
 * handlers through the customer middleware pipeline.
 *
 * Flow overview:
 *
 *   1. Customer starts identity verification → `handleStartIdentity`
 *      creates a Didit session, persists a `kyc_sessions` row with
 *      `kind = 'customer'`, and returns the redirect URL.
 *
 *   2. After identity approval, customer starts address verification
 *      → `handleStartAddress` (same pattern, different workflow).
 *
 *   3. `handleGetKycStatus` returns current level / score / sessions.
 *
 *   4. `handleResumeSession` polls Didit for an in-progress session
 *      and returns the current status + redirect URL.
 *
 *   5. `handleGetCredential` returns a summary of the customer's
 *      credential derived from their current KYC level.
 *
 *   6. `handleKycEvents` opens an SSE stream for real-time updates.
 *
 * @module
 */

import type { NextResponse } from 'next/server';
import { NextResponse as NextResponseClass } from 'next/server';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomBytes, createHash } from 'crypto';
import QRCode from 'qrcode';

import type { CustomerContext, RequestContext } from '../context';
import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import { customerActor, customerLabel, systemActor } from '@/lib/audit/actors';
import {
  buildRequestContext as buildAuditRequestContext,
  EMPTY_CONTEXT,
} from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { getAppUrl } from '@/lib/env/app-url';
import { getDiditConfig } from '@crivacy-fhe/adapter-didit/config';
import { getRootLogger } from '@/lib/observability/logger';
import {
  createKycSession,
  createAddressSession,
  getDecision,
  validateVendorData,
} from '@crivacy-fhe/adapter-didit/session';
import type { ExpectedDetailsInput } from '@crivacy-fhe/adapter-didit/session';
import { parseFullName } from '@crivacy-fhe/adapter-didit/users';
import { asDiditSessionIdUnchecked, DIDIT_STATUS } from '@crivacy-fhe/adapter-didit/types';
import { isDiditErrorWithCode } from '@crivacy-fhe/adapter-didit/errors';
import {
  mapDiditStatusToInternal,
  PULL_OVERWRITABLE_STATUSES,
} from '@crivacy-fhe/adapter-didit/status-mapping';
import type { DiditConfig } from '@crivacy-fhe/adapter-didit/config';
import type { CustomerKycLevel } from '@/lib/customer/score';
import {
  kycLevelName,
  nextKycLevel,
  MAX_SCORE,
} from '@/lib/customer/score';
import {
  ADDRESS_PHASE,
  IDENTITY_PHASE,
  findPhaseByDiditWorkflow,
  isCustomerKycLevel,
} from '@/lib/kyc/phase-registry';
import type { MintProgress } from '@/lib/kyc/phase-registry';
import { resolveMintProgress } from '@/lib/kyc/mint-progress';
import type { KycStatus } from '@crivacy/shared-types';
import { createSSEStream } from '@/lib/sse';
import { KYC_EVENTS } from '@/lib/sse/events';
import type { KycStatusChangedData, KycHandoffConsumedData } from '@/lib/sse/events';
import { ACTIVE_SESSION_STATUSES } from '@/lib/kyc/session-status-display';
import { hashIp, isOverThreshold as isIpOverThreshold } from '@/lib/fraud/ip-abuse';
import {
  applyFaceMatchSideEffects,
  evaluateDeclineLock,
  evaluateFaceMatchFromDecision,
  incrementDecline,
} from '@/lib/fraud';

// ---------------------------------------------------------------------------
// Types — customer-refined session row (Sprint 7 Phase F)
// ---------------------------------------------------------------------------

/**
 * Customer-flow refinement of `kycSessions.$inferSelect`. After the
 * Phase F nullability flip the unified select type carries
 * `customerId: string | null` (b2b rows have it null) and the b2b
 * columns (`firmId`, `userRef`, `level`, `createdByApiKeyId`) as
 * `string | null` (customer rows have them null).
 *
 * Every read path in this handler filters by `kind = 'customer'`, so
 * `customerId` is guaranteed non-null by the kind invariant CHECK
 * constraint. The refined type re-projects that runtime invariant so
 * downstream callers (face-match dispatch, pipeline enqueue, audit
 * actor) don't need an `??''` fallback or `!` assertion at every
 * read site.
 */
type CustomerKycSession = Omit<typeof schema.kycSessions.$inferSelect, 'customerId'> & {
  readonly customerId: string;
};

function asCustomerSession(
  row: typeof schema.kycSessions.$inferSelect,
): CustomerKycSession {
  // Caller queries with `kind='customer'` filter; the
  // `kyc_sessions_kind_invariant` CHECK guarantees non-null
  // customerId on those rows.
  return row as unknown as CustomerKycSession;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// `ACTIVE_STATUSES` used to live here. Now sourced from
// `lib/kyc/session-status-display.ts::ACTIVE_SESSION_STATUSES` (single
// source of truth — predicate `isActiveSessionStatus` + Drizzle
// `inArray()` WHERE clauses below all read from the same array).

/**
 * A persisted hosted-flow URL is "stale" when its host matches the
 * Didit API host — i.e. it points to the service we POST sessions
 * to, not the service that actually serves the user-facing flow.
 *
 * Background: Didit historically issued hosted URLs on the same
 * host as their REST API (`verification.didit.me/session/{UUID}`).
 * They have since migrated the user-facing flow to a separate host
 * (`verify.didit.me/session/{shortToken}`), and the legacy URL now
 * returns 404. Sessions created before the migration still carry
 * the legacy URL in `kyc_sessions.verification_url`; if
 * the resume path serves it, the user is sent to a dead page.
 *
 * The fix is host-aware rather than format-aware on purpose: we
 * trust whatever Didit currently returns for `url`, so the only
 * deterministic indicator of a stale row is "stored host equals
 * API host". A future Didit migration that swaps domains again
 * will be caught by the same check without code changes, provided
 * the API host stays distinct from the hosted host (Didit's
 * stated direction).
 *
 * Returns `true` for malformed input as well — a row whose URL we
 * cannot parse is not safely redirectable, so minting a fresh
 * session is the only correct fallback.
 */
function isStaleHostedUrl(url: string, apiBaseUrl: string): boolean {
  let stored: URL;
  let api: URL;
  try {
    stored = new URL(url);
    api = new URL(apiBaseUrl);
  } catch {
    return true;
  }
  return stored.host === api.host;
}

/** Terminal session statuses where no further action is possible. */
const TERMINAL_STATUSES = ['approved', 'rejected', 'expired', 'revoked'] as const;

/** Session expiry: 24 hours from creation. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** SSE heartbeat interval: 30 seconds. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Rolling denial-of-wallet ceiling. Every Didit session we create is
 * billed upstream, so a malicious-but-authenticated customer who
 * restarts verification in a loop can burn our quota. The existing
 * per-minute rate limit (`kyc_start`, 5/min per customer) caps the
 * short-burst side; this cap covers the slow-drain side that survives
 * the rolling window reset.
 *
 * 20 / 30-day window was picked to leave **very** comfortable headroom
 * for legitimate retry stories (a user who retries identity 2-3 times
 * after provider-side failures, then address 2-3 times) while bounding
 * a single account to ~$X × 20 upstream cost per month. An admin-
 * initiated `reset_kyc` does not reset the counter — that action
 * archives the credential state, not the historical session rows; if
 * a legitimate user ever hits the ceiling, support can raise it via a
 * dedicated admin flow (not exposed to customers). The constant lives
 * here so it is trivial to dial if Didit pricing shifts.
 */
const MONTHLY_SESSION_CAP_PER_CUSTOMER = 20;
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// BUG #56 race fix: `assertMonthlySessionBudget` was a stand-alone
// pre-flight count that returned a ready-made 429 — but the count
// happened outside any tx, so two paralel POSTs both observed
// `count<cap`, both passed, both minted billable Didit sessions.
// The check now lives inside each handler's per-customer advisory-
// locked transaction (see `handleStartIdentity` / `handleStartAddress`),
// where count → mint → insert is atomic across paralel callers and
// the cap actually holds.

/**
 * Inside-tx idempotency window. The outer "active session" fast-path
 * (above the advisory lock) cannot see a session a sibling request
 * just inserted; both requests would slip past it, queue on the lock,
 * and each spend a billable Didit slot. The inside-tx check below
 * (run AFTER the lock acquire) catches a session created in the
 * preceding {@link RECENT_RESUME_WINDOW_MS} and returns it as resume
 * instead of wiping-and-creating. 60s is wide enough to absorb
 * realistic double-click + "click then immediate refresh" UX races
 * while staying short enough that a stale tab returning 5 minutes
 * later still gets a fresh session if the original verification URL
 * is no longer usable.
 */
const RECENT_RESUME_WINDOW_MS = 60 * 1000;

/**
 * Approved-but-mint-not-yet-finalized window for the inside-tx guard.
 * Between Didit's webhook stamping `kyc_sessions.status='approved'`
 * and the credential-pipeline-worker writing
 * `kyc_credentials_meta.status='active'`, the customer is still at
 * `kyc_level=kyc_3` (or `kyc_0` for identity), so eligibility passes
 * and a fresh "Start" click would happily mint a duplicate Didit
 * session that becomes orphaned the instant the original mint lands.
 * Within {@link MINT_PENDING_WINDOW_MS} we 409 the new attempt with
 * `kyc_mint_pending` and let SSE surface the verdict; past the
 * window we treat the prior session as stuck (the
 * stuck-mint reconciler pass owns it) and allow a clean retry.
 */
const MINT_PENDING_WINDOW_MS = 30 * 60 * 1000;

/**
 * Drizzle transaction handle, structurally narrower than
 * {@link CrivacyDatabase} but compatible for the `select` / `update` /
 * `insert` / `execute` calls the start-guard helper makes. Extracted
 * via `Parameters` so a future drizzle bump that retypes `transaction`
 * propagates here without a second hand-rolled type.
 */
type KycTx = Parameters<Parameters<CrivacyDatabase['transaction']>[0]>[0];

/** Outcome of the inside-tx start guard — see {@link evaluateStartGuardInTx}. */
type StartGuardOutcome =
  | { readonly kind: 'resume'; readonly sessionId: string; readonly redirectUrl: string }
  | { readonly kind: 'mint_pending' }
  | { readonly kind: 'create_new' };

/**
 * Sentinel exception for `handleMintNft`'s lock-tx body. Lets the
 * inside-tx code abort with a structured reason that the outer catch
 * translates into a `ctx.errorJson(...)` response, without losing
 * type narrowing or leaking a half-finished tx.
 */
class MintNftAbort extends Error {
  readonly reason:
    | 'credential_not_active'
    | 'nft_already_minted'
    | 'command_already_submitted';
  constructor(reason: MintNftAbort['reason']) {
    super(reason);
    this.name = 'MintNftAbort';
    this.reason = reason;
  }
}

/**
 * Inside-tx race+orphan guard for `handleStartIdentity` /
 * `handleStartAddress`. Closes two windows the outer fast-path
 * cannot:
 *
 *   1. Double-click within {@link RECENT_RESUME_WINDOW_MS} — both
 *      requests pass the outer "active session" check (no row visible
 *      yet), serialize on the advisory lock, and the second sees the
 *      first's freshly-inserted row here. Returning resume avoids
 *      burning a second Didit billable session and prevents the
 *      orphan-pending row left behind by wipe-and-create.
 *
 *   2. Start clicked between Didit-Approved and chain mint completion
 *      — the previous session is `status='approved'` (terminal, so
 *      invisible to {@link ACTIVE_SESSION_STATUSES}), but the mint
 *      pipeline is still in flight (no `kyc_credentials_meta` row at
 *      `status='active'` yet). Allowing a fresh session here doubles
 *      the Didit cost AND creates an orphan the forward-drift
 *      reconciler skips (customer has effectively-active credential
 *      pending). Returning `mint_pending` lets SSE surface the verdict.
 *
 * Caller invokes this AFTER `pg_advisory_xact_lock` and BEFORE the
 * wipe-and-create path. On `resume` / `mint_pending` the caller
 * short-circuits the tx; on `create_new` it proceeds.
 */
async function evaluateStartGuardInTx(
  tx: KycTx,
  customerId: string,
  workflow: 'identity' | 'address',
  now: Date,
  diditConfig: DiditConfig,
): Promise<StartGuardOutcome> {
  const recentResumeFloor = new Date(now.getTime() - RECENT_RESUME_WINDOW_MS);
  const mintPendingFloor = new Date(now.getTime() - MINT_PENDING_WINDOW_MS);

  // Check 1: a sibling request inserted a fresh active session within
  // the resume window. Order desc + limit 1 picks the newest row in
  // the unlikely case there are multiple (only possible if the partial
  // unique index slot was freed mid-window).
  const recentRows = await tx
    .select({
      id: schema.kycSessions.id,
      verificationUrl: schema.kycSessions.verificationUrl,
    })
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.customerId, customerId),
        eq(schema.kycSessions.workflow, workflow),
        inArray(schema.kycSessions.status, [...ACTIVE_SESSION_STATUSES]),
        sql`${schema.kycSessions.createdAt} > ${recentResumeFloor}`,
      ),
    )
    .orderBy(sql`${schema.kycSessions.createdAt} DESC`)
    .limit(1);
  const recent = recentRows[0];
  if (
    recent !== undefined &&
    recent.verificationUrl !== null &&
    !isStaleHostedUrl(recent.verificationUrl, diditConfig.baseUrl)
  ) {
    return { kind: 'resume', sessionId: recent.id, redirectUrl: recent.verificationUrl };
  }

  // Check 2: an approved-but-not-minted session lives in the mint-
  // pending window. LEFT JOIN on `status='active'` lets us spot the
  // case in a single round-trip; rows with an active meta have
  // `m.id IS NOT NULL` and are filtered out.
  const pendingMint = await tx.execute<{ id: string }>(sql`
    SELECT s.id::text AS id
      FROM ${schema.kycSessions} s
 LEFT JOIN ${schema.kycCredentialsMeta} m
        ON m.kyc_session_id = s.id
       AND m.status = 'active'
     WHERE s.customer_id = ${customerId}
       AND s.workflow = ${workflow}
       AND s.status = 'approved'
       AND s.created_at > ${mintPendingFloor}
       AND m.id IS NULL
     LIMIT 1
  `);
  if (pendingMint.rows[0] !== undefined) {
    return { kind: 'mint_pending' };
  }

  return { kind: 'create_new' };
}

// ---------------------------------------------------------------------------
// SSE per-customer connection cap
// ---------------------------------------------------------------------------

/**
 * Ceiling on concurrent SSE connections a single customer may hold
 * open at any given moment. SSE streams are long-lived (heartbeat
 * every 30s, DB poll every 5s, 10-minute hard timeout), so a
 * scripted client that opens tabs in a loop would otherwise pin one
 * long-running DB poll per tab — a cheap single-tenant DoS. Three
 * slots covers the legitimate multi-tab pattern (dashboard +
 * credential page + a lingering KYC window) and rejects the 4th
 * with 429.
 */
const MAX_SSE_CONNECTIONS_PER_CUSTOMER = 3;

/**
 * Per-process counter. In a single-replica deployment this is the
 * whole picture — the counter tracks every live SSE connection by
 * customer id. In a multi-replica deployment each node enforces the
 * cap locally, which means a customer can hold up to
 * `replicas × MAX_SSE_CONNECTIONS_PER_CUSTOMER` total. That bound
 * is still finite and still upstream of any DB-pool exhaustion
 * attack; a Redis-backed counter only matters when we want a truly
 * global cap, which is scoped out of this fix.
 *
 * The map entry is removed (not left at 0) when the last
 * connection drops so the map does not grow unbounded across the
 * lifetime of the process.
 */
const activeSseConnections = new Map<string, number>();

function activeSseCount(customerId: string): number {
  return activeSseConnections.get(customerId) ?? 0;
}

function incrementActiveSse(customerId: string): void {
  activeSseConnections.set(customerId, activeSseCount(customerId) + 1);
}

function decrementActiveSse(customerId: string): void {
  const current = activeSseCount(customerId);
  if (current <= 1) {
    activeSseConnections.delete(customerId);
    // Last SSE connection for this customer dropped — also drop the
    // Didit-pull throttle entry so the map does not accumulate one
    // entry per customer that ever connected. The trade-off: a
    // reconnect inside the throttle window starts with a fresh
    // budget (one extra Didit call worst case), which is acceptable.
    lastDiditPullByCustomer.delete(customerId);
    return;
  }
  activeSseConnections.set(customerId, current - 1);
}

/**
 * Test-only — flush the process-scope counter between cases so a
 * leaked slot from one test cannot pre-exhaust the cap in the
 * next. Not exported from the barrel; imported by the unit tests
 * directly.
 */
export function resetActiveSseConnectionsForTests(): void {
  activeSseConnections.clear();
  lastDiditPullByCustomer.clear();
}

/** SSE polling interval for status changes: 5 seconds. */
const POLL_INTERVAL_MS = 5_000;

/**
 * Minimum interval between Didit `getDecision` pulls per customer
 * across all of that customer's SSE connections. Prevents N tabs from
 * each pulling Didit on every poll tick — the throttle is shared via
 * an in-memory map below.
 *
 * 6 s is a deliberate compromise: > POLL_INTERVAL_MS (so the first
 * poll-tick after the throttle window is permitted to pull) and short
 * enough that a Didit decision surfaces on the desktop within ~one
 * extra poll cycle of it becoming available. Halved from the original
 * 12 s so a desktop-only flow (no phone handoff driving the pull)
 * detects approval roughly twice as fast; the extra Didit API calls
 * only occur during the brief in-flight window per customer.
 *
 * Pull-fallback purpose: in production it self-heals missed webhooks
 * (rare, but real — webhook retries can be exhausted if the receiver
 * was 5xx for a stretch); in local dev it is the *only* path that
 * surfaces the decision because Didit's outbound webhook cannot reach
 * a localhost / RFC 1918 origin.
 */
const DIDIT_PULL_THROTTLE_MS = 6_000;

/**
 * Per-customer last-pull timestamp (ms since epoch). Shared across
 * every SSE connection that customer has open in this process so the
 * throttle is a customer-wide ceiling, not per-tab. Multi-replica
 * deployments enforce per-replica only — global Didit burn is bounded
 * by `replicas × MAX_SSE_CONNECTIONS_PER_CUSTOMER × (1 / DIDIT_PULL_THROTTLE_MS)`.
 *
 * Cleared lazily: when an SSE connection ends and no other connection
 * for the same customer remains active (`activeSseCount === 0`), the
 * entry is removed so the map does not grow unbounded across
 * long-lived process lifetimes.
 */
const lastDiditPullByCustomer = new Map<string, number>();

/**
 * Pull-fallback: query Didit for the current decision and apply it to
 * the local DB row if it changed. Mirrors the Approved / Declined /
 * In Progress / Expired branches in `handleResumeSession` exactly so
 * both surfaces converge on the same state-machine — webhook arriving
 * later just observes the current row and no-ops via the atomic
 * UPDATE..WHERE status guard.
 *
 * Concurrency safety:
 *   - The UPDATE clauses include a status guard (`WHERE id=X AND
 *     status IN ('pending','in_progress')`) so a webhook that already
 *     moved the row to `identity_approved` cannot be clobbered by a
 *     stale-by-12s pull arriving immediately after.
 *   - Credential-pipeline enqueue uses pg-boss `singletonKey` so the
 *     same job is deduped if both webhook + pull enqueue it.
 *
 * Returns the new status when a transition occurred, `null` otherwise.
 * Errors are caught and reported in the result so the SSE poll loop
 * never tears down the stream because Didit is briefly unreachable.
 */
/**
 * Pull-fallback: query Didit for the current decision and apply it
 * to the local DB row when the value differs and the row is still in
 * an overwritable state. Mirrors the entire 9-status map from the
 * webhook handler (`didit-webhook.ts::statusMap`), so the desktop
 * SSE event fires whether the decision arrived via webhook (push) or
 * via this pull cycle.
 *
 * Concurrency safety:
 *   - The UPDATE includes a status guard
 *     (`WHERE id=X AND status IN (...overwritable)`) so a webhook
 *     that already moved the row to a terminal status cannot be
 *     clobbered by a stale-by-12s pull.
 *   - Credential-pipeline enqueue (Approved branch only) uses
 *     pg-boss `singletonKey` so the same job is deduped if both
 *     webhook + pull enqueue it.
 *
 * Error branching:
 *   - DiditError(`not_found`)        → Didit no longer recognises the
 *     session id (operator deleted the user / session purged). The
 *     row cannot recover — flip to `expired` so the UI can route the
 *     customer to a fresh-start surface.
 *   - DiditError(`unknown_workflow`) → workflow id rotated since the
 *     session was created; Didit returns the row but our config no
 *     longer knows the workflow → row is unrecoverable for this
 *     deployment → flip to `expired`.
 *   - DiditError(`invalid_response`) → schema parse failed (rare with
 *     the loosened schema). Log warn, leave row alone — Didit may
 *     have shipped a transient malformed payload.
 *   - Network / timeout / 5xx       → log warn, leave row alone —
 *     transient infra issue, retry on the next throttle window.
 *
 * Returns the new status string when a transition occurred,
 * `null` otherwise (no change, race-lost UPDATE, error).
 */
async function pullAndApplyDiditDecision(
  db: CrivacyDatabase,
  session: CustomerKycSession,
  now: Date,
  diditConfig: DiditConfig,
): Promise<{ readonly newStatus: string | null }> {
  if (session.diditSessionId === null) {
    return { newStatus: null };
  }
  const sessionId = session.id;
  let decision;
  try {
    const diditSessionId = asDiditSessionIdUnchecked(session.diditSessionId);
    decision = await getDecision(diditConfig, diditSessionId);
  } catch (err) {
    // Terminal error: the Didit session is unrecoverable for this
    // configuration. Flip our row to `expired` so the desktop UI
    // can route the customer to "Start a new verification" instead
    // of waiting for a webhook that will never come.
    if (isDiditErrorWithCode(err, 'not_found', 'unknown_workflow')) {
      const reason = err.code === 'not_found'
        ? 'Verification session no longer recognised by provider.'
        : 'Verification workflow has been rotated; please start a new verification.';
      const updated = await db
        .update(schema.kycSessions)
        .set({
          status: 'expired',
          failureReason: reason,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.kycSessions.kind, 'customer' as const),
            eq(schema.kycSessions.id, sessionId),
            inArray(
              schema.kycSessions.status,
              [...PULL_OVERWRITABLE_STATUSES],
            ),
          ),
        )
        .returning({ id: schema.kycSessions.id });
      if (updated.length > 0) {
        getRootLogger().info(
          {
            event: 'customer_kyc_sse_pull_marked_expired',
            sessionId,
            diditErrorCode: err.code,
          },
          'SSE pull-fallback: marked session expired (Didit rejected the lookup permanently)',
        );
        return { newStatus: 'expired' };
      }
      return { newStatus: null };
    }
    // Transient error — log and retry on next throttle window.
    getRootLogger().warn(
      {
        event: 'customer_kyc_sse_didit_pull_failed',
        sessionId,
        err: err instanceof Error
          ? { name: err.name, message: err.message }
          : String(err),
      },
      'SSE pull-fallback: Didit getDecision failed (will retry on next throttle window)',
    );
    return { newStatus: null };
  }

  const internal = mapDiditStatusToInternal(decision.status);
  if (internal === null) {
    // Status string we don't recognise — log audit-grade so the SOC
    // sees the new value, but do not flip the row to a speculative
    // state. Eventually either we wire the new value into the map
    // OR the value transitions to a known terminal status and the
    // next pull picks it up.
    getRootLogger().warn(
      {
        event: 'customer_kyc_sse_pull_unknown_status',
        sessionId,
        rawStatus: decision.status,
      },
      'SSE pull-fallback: Didit returned an unmapped status (no DB transition applied)',
    );
    return { newStatus: null };
  }

  // For the Approved + identity workflow, our internal status is
  // `identity_approved` (intermediate state — address verification is
  // a separate workflow). For Approved + address workflow, terminal
  // `approved`. Both other workflows would map verbatim if Didit
  // ever ships more.
  let writeStatus =
    internal === 'approved' && session.workflow === 'identity'
      ? 'identity_approved'
      : internal;

  // Sprint 6 — face-match cascade evaluation on pull-fallback. The
  // webhook handler runs the same eval; this runs when the push
  // channel is dead (local dev, missed/expired retry) so the SSE
  // pull is the ONLY surface that reaches a fraud anchor. Without
  // this, a banned-face attempt that arrived only via pull would
  // mint a credential.
  let faceMatchEval = null as Awaited<
    ReturnType<typeof evaluateFaceMatchFromDecision>
  >;
  let faceMatchOverrideReason: 'fraud_cascade' | 'face_match_blocked' | null = null;
  if (
    writeStatus === 'identity_approved' ||
    writeStatus === 'approved' ||
    writeStatus === 'rejected'
  ) {
    faceMatchEval = await evaluateFaceMatchFromDecision(db, decision, {
      kind: 'customer',
      customerId: session.customerId,
    });
    if (faceMatchEval !== null && faceMatchEval.overrideReason !== null) {
      writeStatus = 'rejected';
      faceMatchOverrideReason = faceMatchEval.overrideReason;
    } else if (faceMatchEval !== null && faceMatchEval.evaluation.kind === 'reuse') {
      getRootLogger().info(
        {
          event: 'customer_kyc_sse_pull_face_match_reuse_pending_impl',
          customerId: session.customerId,
          sessionId,
        },
        'Sprint 6 reuse branch (pull) — rebind path not yet implemented; continuing with normal mint',
      );
    }
  }

  // No-op fast path: the projected target status already matches the
  // local row → nothing to write, no event to emit. Compare AFTER the
  // identity_approved projection above so the check is meaningful;
  // comparing the raw `internal` ('approved') against
  // `session.status` ('identity_approved') would always mismatch and
  // cause a re-write + re-enqueue every poll cycle (12 s spam).
  if (writeStatus === session.status) {
    return { newStatus: null };
  }

  // Sprint 6: prefer the human-readable warning description from
  // the highest-priority Didit warning code (e.g.
  // `DUPLICATED_FACE` → "Duplicated face from another approved
  // session"). Falls back to the generic "Verification declined by
  // provider." when the session was declined without a known
  // warning code (e.g. workflow misconfigured, transient failure).
  // Face-match override beats Didit's text — the cascade reason is
  // more specific than "Declined".
  const failureReason =
    faceMatchOverrideReason !== null
      ? faceMatchOverrideReason
      : writeStatus === 'rejected'
      ? (decision.failureReasonText ?? 'Verification declined by provider.')
      : null;
  const completedAt =
    writeStatus === 'rejected' ||
    writeStatus === 'expired' ||
    writeStatus === 'approved' ||
    writeStatus === 'identity_approved' ||
    writeStatus === 'kyc_expired'
      ? now
      : null;

  const setPayload: Record<string, unknown> = {
    status: writeStatus,
    diditDecisionPayload: decision as unknown as Record<string, unknown>,
    updatedAt: now,
  };
  if (failureReason !== null) setPayload['failureReason'] = failureReason;
  if (completedAt !== null) setPayload['completedAt'] = completedAt;

  const updated = await db
    .update(schema.kycSessions)
    .set(setPayload)
    .where(
      and(
        eq(schema.kycSessions.kind, 'customer' as const),
        eq(schema.kycSessions.id, sessionId),
        inArray(
          schema.kycSessions.status,
          [...PULL_OVERWRITABLE_STATUSES],
        ),
      ),
    )
    .returning({ id: schema.kycSessions.id });

  if (updated.length === 0) {
    // Webhook (or another pull) won the race — row is no longer in
    // an overwritable status. No event to emit; the winning writer
    // already drove the SSE status_changed.
    return { newStatus: null };
  }

  // Sprint 6 — fire face-match side-effects AFTER the row UPDATE so
  // `revokeActiveKycSessions` (inside cascadeBan) sees the current
  // row at status='rejected' and skips it. The webhook handler does
  // the same; only the surface label differs (`pull_customer` for
  // SOC routing).
  if (faceMatchEval !== null && faceMatchEval.evaluation !== null) {
    await applyFaceMatchSideEffects(db, {
      evaluation: faceMatchEval.evaluation,
      context: { kind: 'customer', customerId: session.customerId },
      decision,
      currentDiditSessionId: decision.sessionId as unknown as string,
      customerKycSessionId: sessionId,
      auditContext: EMPTY_CONTEXT,
      surface: 'pull_customer',
      now,
    });
  }

  // Per-customer decline counter (anti-Didit-budget-burn gate). Only
  // bump on a winning decline writer. Skip when the cascade demoted
  // the row to rejected — `cascadeBan` already locked the account
  // via `customers.locked_at`, double-counting would just delay the
  // SOC signal without changing behaviour.
  if (writeStatus === 'rejected' && faceMatchOverrideReason === null) {
    await incrementDecline(db, {
      customerId: session.customerId,
      surface: 'pull_fallback',
      auditContext: EMPTY_CONTEXT,
      kycSessionId: sessionId,
      now,
    });
  }

  // Approved + identity workflow → enqueue the credential pipeline
  // exactly as `handleResumeSession` does. Webhook handler also
  // enqueues; the pg-boss singletonKey on the job dedups so a
  // pull-vs-webhook race doesn't double-issue a credential.
  // Skip enqueue when the cascade demoted the row to rejected —
  // we don't want to mint a credential for a banned face.
  if (
    (writeStatus === 'identity_approved' || writeStatus === 'approved') &&
    faceMatchOverrideReason === null
  ) {
    try {
      await enqueueCredentialPipelineFromResume(
        sessionId,
        session.customerId,
        session.diditSessionId,
        session.workflow === 'identity' ? 'identity' : 'address',
      );
    } catch (enqueueErr) {
      getRootLogger().error(
        {
          event: 'customer_kyc_sse_pull_enqueue_failed',
          sessionId,
          err: enqueueErr instanceof Error
            ? { name: enqueueErr.name, message: enqueueErr.message }
            : String(enqueueErr),
        },
        'SSE pull-fallback: failed to enqueue credential pipeline (webhook path may still pick it up)',
      );
    }
  }

  return { newStatus: writeStatus };
}


/**
 * Statuses the pull-fallback considers worth polling Didit for. The
 * caller checks whether the local row is in one of these BEFORE the
 * throttle decision so the burn is bounded to "row could still
 * change". Terminal local statuses (approved / rejected / expired /
 * revoked / kyc_expired) skip pull entirely.
 */
const PULLABLE_STATUSES = [
  'pending',
  'in_progress',
  'in_review',
  'resubmission_pending',
  'identity_approved',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely load the Didit configuration. Returns null and logs the error
 * if the environment is misconfigured (e.g. local dev without Didit keys).
 */
function loadDiditConfigSafe(): DiditConfig | null {
  try {
    return getDiditConfig();
  } catch {
    return null;
  }
}

/**
 * Map a database session row to the API response shape.
 *
 * `redirectUrl` is the Didit-hosted flow URL we persisted at session
 * create time (the `url` field of `POST /v3/session/`). We hand it
 * back as-is; do not reconstruct a URL from `diditSessionId`. Didit
 * has migrated their hosted flow domain (`verification.didit.me` →
 * `verify.didit.me`) and the new path format uses a short token
 * rather than the session UUID, so any client-side reconstruction
 * lands on a 404. The persisted column is the only source of truth.
 *
 * Stale rows created before Didit's migration may still hold the
 * old-format URL; the resume paths in `handleStartIdentity` /
 * `handleStartAddress` detect those and mint a fresh session, so
 * the column converges to the current format on the next click.
 */
function mapSessionRow(row: typeof schema.kycSessions.$inferSelect) {
  return {
    id: row.id,
    workflow: row.workflow,
    status: row.status,
    redirectUrl: row.verificationUrl,
    failureReason: row.failureReason,
    attempts: row.attempts,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt !== null ? row.completedAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    // Surfaced only when Didit has flagged a Resubmission against this
    // session. The customer UI uses `resubmissionInfo.nodes` to render
    // the list of steps the user needs to redo; null on every other
    // session.
    resubmissionInfo: row.resubmissionInfo,
  } as const;
}

// ---------------------------------------------------------------------------
// handleGetKycStatus
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/kyc/status
 *
 * Returns the customer's current KYC level, score, and session history.
 *
 * NFT mint state is included via a single `kyc_credentials_meta` lookup so
 * the /kyc page can drive Step 4 ("Soulbound NFT") status from this endpoint
 * alone — no second roundtrip, no chain RPC. The /credential page still
 * uses `/api/customer/kyc/credential` for the rich on-chain artefact (image,
 * serial number, display name) when the showcase needs to render. This split
 * eliminates the SWR loading-window race that previously made Step 4 flash
 * "Minting…" for the duration of the credential fetch even when the NFT was
 * already minted in the database.
 */
export async function handleGetKycStatus(ctx: CustomerContext): Promise<NextResponse> {
  const { customer, db } = ctx;

  const kycLevel = isCustomerKycLevel(customer.kycLevel)
    ? customer.kycLevel
    : 'kyc_0' as CustomerKycLevel;

  // Fetch all sessions for this customer, most recent first
  const sessions = await db
    .select()
    .from(schema.kycSessions)
    .where(eq(schema.kycSessions.customerId, customer.id))
    .orderBy(desc(schema.kycSessions.createdAt));

  // Suppress stored hosted-flow URLs whose host has been deprecated
  // by Didit so the customer dashboard never offers a "Continue
  // Verification" button that lands on a 404. The button is shown
  // only when `redirectUrl` is truthy (kyc/page.tsx); replacing the
  // URL with `null` here flips the UI back to "Start Verification",
  // which routes through `handleStartIdentity` / `handleStartAddress`
  // — both of which detect the stale row, expire it inside their
  // locked tx, and mint a fresh session in one click.
  //
  // Config load is a Zod parse over env; if it fails we leave URLs
  // intact rather than null-ing every row (a degraded API response
  // is better than telling every active customer they have no
  // session). The start-* handlers re-validate independently.
  const diditConfig = loadDiditConfigSafe();
  const apiHost = diditConfig?.baseUrl;
  const cleanedSessions = apiHost === undefined
    ? sessions
    : sessions.map((row) =>
        row.verificationUrl !== null && isStaleHostedUrl(row.verificationUrl, apiHost)
          ? { ...row, verificationUrl: null }
          : row,
      );

  // Active credential + NFT mint state. NULL when the customer has no
  // active credential yet (Basic / Enhanced phases not finalised) or
  // when the NFT row exists but the worker has not yet propagated the
  // contract id. The "minting now" stepper state is genuine in that
  // window — it is never inferred from a still-loading client fetch.
  const activeCredentialRows = await db
    .select({
      chainContractId: schema.kycCredentialsMeta.chainContractId,
      chainNetwork: schema.kycCredentialsMeta.chainNetwork,
      level: schema.kycCredentialsMeta.level,
      status: schema.kycCredentialsMeta.status,
      nftContractId: schema.kycCredentialsMeta.nftContractId,
      nftMintedAt: schema.kycCredentialsMeta.nftMintedAt,
      nftBurnedAt: schema.kycCredentialsMeta.nftBurnedAt,
    })
    .from(schema.kycCredentialsMeta)
    .where(
      and(
        eq(schema.kycCredentialsMeta.userRef, customer.id),
        eq(schema.kycCredentialsMeta.status, 'active'),
      ),
    )
    .orderBy(desc(schema.kycCredentialsMeta.createdAt))
    .limit(1);

  const activeCredentialRow = activeCredentialRows[0] ?? null;
  const nftMintedLive =
    activeCredentialRow !== null &&
    activeCredentialRow.nftContractId !== null &&
    activeCredentialRow.nftBurnedAt === null &&
    activeCredentialRow.nftMintedAt !== null;

  // Per-phase mint-progress projection. Surfaces the gap between
  // "Didit returned approved" and "chain commit landed in the meta
  // table" so the /kyc stepper can render an animated "issuing
  // credential" sub-step instead of falsely displaying the parent
  // step as either active (start CTA) or completed (✓ green) during
  // the in-flight window. We pick the latest session per phase here
  // — sessions are already sorted desc by createdAt — and only run
  // the projector when the row's status opens the mint window.
  const latestIdentitySession = sessions.find((s) => s.workflow === 'identity') ?? null;
  const latestAddressSession = sessions.find((s) => s.workflow === 'address') ?? null;
  const [identityMintProgress, addressMintProgress]: [MintProgress | null, MintProgress | null] =
    await Promise.all([
      latestIdentitySession === null
        ? Promise.resolve(null)
        : resolveMintProgress(db, {
            kycSessionId: latestIdentitySession.id,
            sessionStatus: latestIdentitySession.status,
            phase: 'identity',
          }),
      latestAddressSession === null
        ? Promise.resolve(null)
        : resolveMintProgress(db, {
            kycSessionId: latestAddressSession.id,
            sessionStatus: latestAddressSession.status,
            phase: 'address',
          }),
    ]);

  const next = nextKycLevel(kycLevel);

  // Wallet-link state. A customer credential is keyed by (and only
  // decryptable with) the customer's own EVM wallet, so the /kyc page
  // must block "Start verification" until a wallet is linked — otherwise
  // the customer burns a full Didit KYC and the mint silently fails.
  // Surfaced here so the frontend gate mirrors the server-side gate in
  // `handleStartIdentity` / `handleStartAddress`.
  const { getCustomerWalletAddress } = await import('@/lib/fhe/customer-address');
  const hasWallet = (await getCustomerWalletAddress(db, customer.id)) !== null;

  // Per-customer decline-counter snapshot. The /kyc page reads this
  // to render the cooldown banner + countdown when the customer has
  // hit the start-* gate. `evaluateDeclineLock` is the same helper
  // the gate uses, so frontend and backend agree on "is this customer
  // currently locked".
  const declineLock = evaluateDeclineLock(
    {
      consecutiveKycDeclines: customer.consecutiveKycDeclines,
      lastDeclineAt: customer.lastDeclineAt,
    },
    ctx.now,
  );

  return ctx.json({
    kycLevel,
    kycScore: customer.kycScore,
    levelName: kycLevelName(kycLevel),
    nextLevel: next,
    nextLevelName: next !== null ? kycLevelName(next) : null,
    maxScore: MAX_SCORE,
    // Whether the customer has a linked EVM wallet. The /kyc start CTAs
    // are disabled until this is true (credential is keyed by + owned by
    // the wallet). Server-side gate enforces the same in the start
    // handlers, so a manipulated UI cannot bypass it.
    hasWallet,
    sessions: cleanedSessions.map(mapSessionRow),
    activeCredential: activeCredentialRow === null
      ? null
      : {
          chainContractId: activeCredentialRow.chainContractId,
          chainNetwork: activeCredentialRow.chainNetwork,
          level: activeCredentialRow.level,
          status: activeCredentialRow.status,
        },
    nftContractId: nftMintedLive ? activeCredentialRow.nftContractId : null,
    nftMintedAt: nftMintedLive ? activeCredentialRow.nftMintedAt!.toISOString() : null,
    // Didit-revoke signal (Batch E). Non-null when Didit deleted /
    // blocked the user-entity; the /kyc page renders a banner +
    // restart prompt and the start-session handlers refuse 409 until
    // the customer initiates a fresh re-verification flow.
    revokedAt: customer.revokedAt !== null ? customer.revokedAt.toISOString() : null,
    // Decline lock state — per-customer cap on consecutive Didit
    // declines. `count` is the running consecutive count;
    // `cooldownEndsAt` is set only while the lock is active, null
    // otherwise. UI uses this to swap the start CTA for a cooldown
    // panel and to render an explicit "verification declined" pane
    // anchored to the most recent rejected session's failureReason.
    declineLock: {
      locked: declineLock.locked,
      count: declineLock.count,
      threshold: declineLock.threshold,
      cooldownEndsAt: declineLock.cooldownEndsAt?.toISOString() ?? null,
    },
    // Per-phase chain mint progress. Non-null only inside the gap
    // between Didit-approved decision and the on-chain commit
    // landing in `kyc_credentials_meta`. The /kyc stepper drives
    // the `minting` / `failed` parent statuses + the per-attempt
    // sub-step row off these fields.
    mintProgress: {
      identity: identityMintProgress,
      address: addressMintProgress,
    },
  });
}

// ---------------------------------------------------------------------------
// handleStartIdentity
// ---------------------------------------------------------------------------

/**
 * POST /api/customer/kyc/start-identity
 *
 * Create a Didit identity verification session (phase 1: ID document +
 * liveness + face match). The customer is redirected to the Didit hosted
 * flow via the returned `redirectUrl`.
 *
 * Preconditions:
 *   - Customer status must be 'active' (email verified).
 *   - No active identity session may exist.
 *   - Customer must be at kyc_0 or kyc_1 (identity not yet completed).
 */
export async function handleStartIdentity(
  ctx: CustomerContext,
  continueUrl: string | null = null,
): Promise<NextResponse> {
  const { customer, db, now } = ctx;
  const safeContinueUrl = sanitizeContinueUrl(continueUrl);

  // --- 0. Sprint 6 — IP-abuse pre-Didit gate ---
  //
  // Refuses start-session attempts from an IP that has already
  // tripped the repeat-evader threshold (3 strikes within 7 days
  // by default). The counter is incremented by the webhook handler
  // when a face-match cascade or block_toast fires; this gate is
  // the inbound side that stops a fresh account from re-attempting
  // KYC from the same network. 503 short-circuits BEFORE we go to
  // Didit — saves the Didit cost on a known abuser and gives the
  // attempt a generic "temporarily unavailable" message rather than
  // exposing the real reason.
  const ipHash = hashIp(ctx.ip);
  if (ipHash.length > 0) {
    try {
      const overThreshold = await isIpOverThreshold(db, ipHash);
      if (overThreshold) {
        await writeAudit(db, {
          action: 'fraud.repeat_evader_detected',
          actor: systemActor('ip-abuse-gate'),
          target: uuidTarget({ kind: 'customer', id: customer.id }),
          context: buildAuditRequestContext({
            ip: ctx.ip ?? null,
            userAgent: ctx.userAgent ?? null,
            requestId: ctx.requestId,
          }),
          meta: { ipHash, surface: 'start_identity' },
          ts: now,
        }).catch(() => {
          // Audit-write failure must not flip the 503 into a 5xx.
        });
        return ctx.errorJson(
          'service_unavailable',
          'KYC verification is temporarily unavailable from your network. Please try again later.',
          503,
        );
      }
    } catch (ipErr) {
      // Gate failure (DB error / hash secret unavailable) is non-
      // fatal — fail open so legitimate customers are not locked
      // out by an infrastructure issue. Log loud for SOC triage.
      getRootLogger().error(
        {
          event: 'ip_abuse_gate_check_failed',
          surface: 'start_identity',
          err: ipErr instanceof Error
            ? { name: ipErr.name, message: ipErr.message }
            : String(ipErr),
        },
        'IP-abuse gate check failed — proceeding without gate',
      );
    }
  }

  // --- 0b. Per-customer decline gate ---
  //
  // Sister to the IP-abuse gate above. After `THRESHOLD` consecutive
  // declines within the cooldown window, refuse the start-* call BEFORE
  // going to Didit so a customer cannot keep burning Didit budget on
  // bogus document submissions. Counter is cleared by the credential-
  // pipeline-worker on approval (atomic with the level/score bump),
  // so a legitimate retry that succeeds resets the gate immediately.
  // Returns 429 with `cooldownEndsAt` so the UI can render a
  // countdown — distinct from the 503 the IP gate uses.
  const declineLock = evaluateDeclineLock(
    {
      consecutiveKycDeclines: customer.consecutiveKycDeclines,
      lastDeclineAt: customer.lastDeclineAt,
    },
    now,
  );
  if (declineLock.locked) {
    await writeAudit(db, {
      action: 'fraud.kyc_decline_locked',
      actor: systemActor('decline-counter-gate'),
      target: uuidTarget({ kind: 'customer', id: customer.id }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        surface: 'start_identity',
        count: declineLock.count,
        threshold: declineLock.threshold,
        cooldownEndsAt: declineLock.cooldownEndsAt?.toISOString() ?? null,
      },
      ts: now,
    }).catch(() => {
      // Audit-write failure must not flip the 429 into a 5xx.
    });
    return ctx.json(
      {
        error: {
          code: 'kyc_decline_locked',
          message:
            'Too many failed verification attempts. Please wait before trying again.',
          cooldownEndsAt: declineLock.cooldownEndsAt?.toISOString() ?? null,
        },
      },
      429,
    );
  }

  // --- 1. Check customer status ---
  //
  // Note on Didit revoke (Batch E): if `customer.revokedAt` is set
  // (Didit deleted/blocked the user-entity), starting identity is the
  // legitimate re-verification path. The level check below already
  // routes such customers (level=kyc_0) into a fresh session mint.
  // The `revoked_at` flag is cleared at the end of this handler when
  // the new session row is committed — that acts as the customer's
  // acknowledgement of the revoke and removes the banner from /kyc.
  if (customer.status !== 'active') {
    return ctx.errorJson(
      'account_not_active',
      'Your account must be verified before starting KYC.',
      403,
    );
  }

  // --- 2. Check KYC level eligibility (Sprint 9: registry-driven) ---
  //
  // `IDENTITY_PHASE.eligibleStartLevels` is the single source of
  // truth for "which levels can start a new identity session" —
  // currently `['kyc_0', 'kyc_1']`, excluding `kyc_2` (the in-flight
  // "document parsed, liveness pending" level owned by Didit) and
  // `kyc_3+` (already completed). Edits go in the registry so the
  // OAuth fast path, the reconciler, and the /kyc UI stay in sync.
  const kycLevel = isCustomerKycLevel(customer.kycLevel)
    ? customer.kycLevel
    : 'kyc_0' as CustomerKycLevel;

  if (!IDENTITY_PHASE.eligibleStartLevels.includes(kycLevel)) {
    return ctx.errorJson(
      'kyc_level_ineligible',
      'Identity verification has already been completed for this account.',
      409,
    );
  }

  // --- 2b. Wallet gate (FHE design invariant) ---
  //
  // A customer credential is keyed by the customer's own EVM wallet
  // address (`_cred[address]` on CrivacyKYC) and only that wallet can
  // decrypt the encrypted fields. Without a linked wallet the credential
  // pipeline throws at mint time (`requireCustomerWalletAddress`) AFTER a
  // full (billable) Didit KYC — a silent, retry-looping failure with no
  // user-facing signal. Refuse up front so the customer links a wallet
  // FIRST. Enforced server-side so a manipulated UI cannot bypass it.
  {
    const { getCustomerWalletAddress } = await import('@/lib/fhe/customer-address');
    const walletAddress = await getCustomerWalletAddress(db, customer.id);
    if (walletAddress === null) {
      return ctx.errorJson(
        'wallet_not_linked',
        'Link an Ethereum wallet before starting verification — your credential is issued to, owned by, and decryptable only with your wallet.',
        409,
      );
    }
  }

  // --- 3. Load Didit config (needed for the stale-URL check below) ---
  const diditConfig = loadDiditConfigSafe();
  if (diditConfig === null) {
    return ctx.errorJson(
      'service_unavailable',
      'KYC verification service is currently unavailable.',
      503,
    );
  }

  // --- 4. Resume existing active identity session instead of creating
  //         a duplicate, BUT only if its persisted hosted URL is still
  //         live for Didit's current flow domain.
  //
  // The kind-aware partial unique index
  // `kyc_sessions_customer_workflow_active_key` already
  // prevents the DB from holding two active rows for the same
  // (customer, workflow) pair. Before that barrier we look up the
  // existing row and hand the browser the SAME Didit hosted URL we
  // issued the first time — idempotent, billable-free. This covers
  // accidental double-clicks, closed-tab returns, and two-tab races.
  //
  // A row whose stored URL is `isStaleHostedUrl` (Didit migrated the
  // hosted host away from the API host, or the URL is unparsable)
  // falls through to the locked tx below, which expires the row and
  // mints a fresh session. Same fall-through for rows with a NULL
  // URL (pre-`verification_url`-migration historical data).
  const activeIdentitySessions = await db
    .select({
      id: schema.kycSessions.id,
      verificationUrl: schema.kycSessions.verificationUrl,
    })
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.customerId, customer.id),
        eq(schema.kycSessions.workflow, 'identity'),
        inArray(schema.kycSessions.status, [...ACTIVE_SESSION_STATUSES]),
      ),
    )
    .limit(1);

  const existing = activeIdentitySessions[0];
  if (
    existing !== undefined &&
    existing.verificationUrl !== null &&
    !isStaleHostedUrl(existing.verificationUrl, diditConfig.baseUrl)
  ) {
    return ctx.json(
      {
        sessionId: existing.id,
        redirectUrl: existing.verificationUrl,
        resumed: true,
      },
      200,
    );
  }

  // --- 5. Build vendor data ---
  const crivacySessionId = crypto.randomUUID();
  const vendorDataRaw = JSON.stringify({
    crivacySessionId,
    type: 'customer',
    customerId: customer.id,
  });
  const vendorData = validateVendorData(vendorDataRaw);

  // --- 6. Determine callback URL ---
  // Didit's `callback` field is the URL the user's browser is
  // redirected to after they finish the hosted flow — it is NOT a
  // webhook delivery target. Webhook (server-to-server, signed) is a
  // separately-configured channel in the Didit dashboard
  // (handled by `/api/webhooks/didit`). Pointing `callback` at our
  // webhook endpoint surfaces a useless API response to the user's
  // phone after verification; the correct destination is the public
  // `/kyc/callback` UX page that says "verification complete, return
  // to your computer". State propagation back to the desktop is
  // handled by the SSE pull-fallback + webhook (whichever wins).
  const appUrl = getAppUrl();
  const callbackUrl = `${appUrl}/kyc/callback`;

  // --- 7-8. Budget check + Didit call + INSERT serialized per-customer.
  //          BUG #56 race fix: the prior code did a SELECT count outside
  //          any tx, then minted a Didit session, then INSERTed. Two
  //          paralel POSTs both observed `count<20`, both passed the
  //          cap check, both burned a Didit budget slot. Per-customer
  //          advisory lock here makes paralel calls serialize through
  //          the count → mint → insert pipeline so the cap holds under
  //          concurrency. Holding the lock through the (slow) Didit
  //          fetch is acceptable for a low-volume KYC endpoint and is
  //          what guarantees DoW protection.
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const verdict = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'kyc_create:' + customer.id}))`,
    );

    // Inside-tx race+orphan guard. See `evaluateStartGuardInTx` for
    // the full reasoning; short version: catches double-click within
    // 60s (resume the sibling's row, no second Didit call) AND catches
    // approved-but-mint-not-yet-finalized sessions (409 mint_pending,
    // user waits for SSE).
    const guard = await evaluateStartGuardInTx(tx, customer.id, 'identity', now, diditConfig);
    if (guard.kind === 'resume') {
      return { kind: 'resume' as const, sessionId: guard.sessionId, redirectUrl: guard.redirectUrl };
    }
    if (guard.kind === 'mint_pending') {
      return { kind: 'mint_pending' as const };
    }

    // Clear any leftover active identity row for this customer.
    // After the resume fast-path above + the inside-tx recent-resume
    // check, the only rows that can still be here are those whose
    // stored URL is null or stale, so they are unrecoverable on the
    // user's side. Expiring them frees the partial unique index slot
    // that would otherwise reject the INSERT a few lines down.
    await tx
      .update(schema.kycSessions)
      .set({ status: 'expired', updatedAt: now })
      .where(
        and(
          eq(schema.kycSessions.customerId, customer.id),
          eq(schema.kycSessions.workflow, 'identity'),
          inArray(schema.kycSessions.status, [...ACTIVE_SESSION_STATUSES]),
        ),
      );

    const budgetRows = await tx
      .select({ count: sql<string>`COUNT(*)::text` })
      .from(schema.kycSessions)
      .where(
        and(
          eq(schema.kycSessions.customerId, customer.id),
          sql`${schema.kycSessions.createdAt} > ${new Date(now.getTime() - MONTHLY_WINDOW_MS)}`,
        ),
      );
    const usedCount = Number.parseInt(budgetRows[0]?.count ?? '0', 10);
    if (usedCount >= MONTHLY_SESSION_CAP_PER_CUSTOMER) {
      return { kind: 'cap_exceeded' as const };
    }

    const diditResult = await createKycSession(diditConfig, vendorData, callbackUrl);

    const insertedRows = await tx
      .insert(schema.kycSessions)
      .values({
        kind: 'customer',
        customerId: customer.id,
        workflow: 'identity',
        status: 'pending',
        diditSessionId: diditResult.sessionId,
        diditWorkflowId: diditResult.workflowId,
        verificationUrl: diditResult.sessionUrl,
        // Sprint 9: persist the OAuth-resume continue URL on the
        // session row so the `/kyc/callback` page can redirect back
        // to e.g. `/oauth/consent?request=...` once Approved.
        // Sanitised at the function entry; null when no resume
        // target was supplied (dashboard-driven start).
        ...(safeContinueUrl !== null
          ? { metadata: { continueUrl: safeContinueUrl } }
          : {}),
        expiresAt,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.kycSessions.id });
    const insertedRow = insertedRows[0];
    if (insertedRow === undefined) {
      return { kind: 'insert_failed' as const };
    }
    return { kind: 'ok' as const, sessionId: insertedRow.id, redirectUrl: diditResult.sessionUrl };
  });

  if (verdict.kind === 'resume') {
    return ctx.json(
      {
        sessionId: verdict.sessionId,
        redirectUrl: verdict.redirectUrl,
        resumed: true,
      },
      200,
    );
  }
  if (verdict.kind === 'mint_pending') {
    return ctx.errorJson(
      'kyc_mint_pending',
      'Verification approved. We are finalizing your credential — please wait a few seconds before retrying.',
      409,
    );
  }
  if (verdict.kind === 'cap_exceeded') {
    return ctx.errorJson(
      'kyc_monthly_limit_exceeded',
      'You have reached the monthly verification limit. Please contact support if you need additional attempts.',
      429,
    );
  }
  if (verdict.kind === 'insert_failed') {
    return ctx.errorJson('internal_error', 'Failed to create KYC session.', 500);
  }

  // F-KYC-A2-A-003: kyc_started audit fires only on a fresh mint —
  // resume hits the early-return above and is not a new initiation.
  await writeAudit(db, {
    action: 'customer.kyc_started',
    actor: customerActor({ id: customer.id, label: customerLabel({ email: customer.email, id: customer.id }) }),
    target: uuidTarget({ kind: 'customer', id: customer.id }),
    context: buildAuditRequestContext({
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId,
    }),
    meta: {
      sessionId: verdict.sessionId,
      workflow: 'identity',
      phase: 'identity',
    },
    ts: now,
  });

  // Acknowledge the Didit-revoke (Batch E) by clearing
  // `revoked_at` / `revoked_reason` once a fresh re-verification
  // session is in flight. Without this clear the /kyc page would
  // keep showing the "verification was revoked" banner even though
  // the customer is already past it.
  if (customer.revokedAt !== null) {
    await db
      .update(schema.customers)
      .set({ revokedAt: null, revokedReason: null, updatedAt: now })
      .where(eq(schema.customers.id, customer.id));
  }

  return ctx.json(
    {
      sessionId: verdict.sessionId,
      redirectUrl: verdict.redirectUrl,
      resumed: false,
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// Sprint 8 — Identity name anchor for address phase
// ---------------------------------------------------------------------------

/**
 * Look up the customer's verified first/last name for the
 * `expected_details` payload of an address (PoA) session.
 *
 * Returns `null` when:
 *   - No approved identity session row exists for the customer
 *   - The identity session's diditSessionId is null (shouldn't happen
 *     post-Sprint-7, but defensively guarded)
 *   - Didit's decision response has no usable kyc.firstName/lastName
 *     (and fullName fallback also fails to parse)
 *   - The Didit decision fetch fails (network, 404, etc.) — caller
 *     fails closed
 *
 * Why we re-fetch the decision instead of caching first_name/last_name:
 * Sprint 1 PII purge — Crivacy's database does not store identity
 * names. Didit retains the decision payload, so we re-fetch on demand
 * each time a customer starts an address session. Cost is negligible
 * (one GET per address session start, typically free under free tier).
 */
async function loadIdentityNameAnchor(
  db: CrivacyDatabase,
  config: DiditConfig,
  customerId: string,
): Promise<ExpectedDetailsInput | null> {
  // Find the identity session that minted the customer's active basic
  // credential. Source-of-truth is `kyc_credentials_meta.status='active'`,
  // NOT `kyc_sessions.status` — the session may have been flipped to
  // 'revoked' or 'expired' by the reverse-drift reconciler / TTL sweep
  // even after the credential was successfully minted (Sprint 7 phase
  // I + reconciler decoupling). The credential is the canonical proof.
  //
  // We join through to `kyc_sessions` only to recover the
  // `didit_session_id` for the decision re-fetch; the session row's
  // own status is intentionally ignored here.
  const rows = await db
    .select({ diditSessionId: schema.kycSessions.diditSessionId })
    .from(schema.kycCredentialsMeta)
    .innerJoin(
      schema.kycSessions,
      eq(schema.kycSessions.id, schema.kycCredentialsMeta.kycSessionId),
    )
    .where(
      and(
        eq(schema.kycCredentialsMeta.userRef, customerId),
        eq(schema.kycCredentialsMeta.status, 'active'),
        eq(schema.kycSessions.workflow, 'identity'),
      ),
    )
    .orderBy(desc(schema.kycCredentialsMeta.createdAt))
    .limit(1);

  const identityRow = rows[0];
  if (identityRow === undefined || identityRow.diditSessionId === null) {
    return null;
  }

  // Re-fetch the decision from Didit. We don't try/catch the Didit
  // error because callers expect either a usable expectedDetails or
  // null — propagating the error would swap the 409 (caller's intent)
  // for a 502/503 (transport error) and that's the wrong UX.
  let decision;
  try {
    decision = await getDecision(config, asDiditSessionIdUnchecked(identityRow.diditSessionId));
  } catch (err) {
    getRootLogger().warn(
      {
        event: 'identity_decision_fetch_failed_for_name_anchor',
        customerId,
        diditSessionId: identityRow.diditSessionId,
        err: err instanceof Error
          ? { name: err.name, message: err.message }
          : String(err),
      },
      'Could not fetch identity decision for address name anchor',
    );
    return null;
  }

  const kyc = decision.kyc;
  if (kyc === null) return null;

  // Prefer pre-parsed first/last (Didit's OCR splits these in the
  // decision payload). Fall back to parsing the full name string when
  // those fields are absent (older decisions, alternative ID formats).
  if (kyc.firstName !== null && kyc.lastName !== null && kyc.firstName.length > 0 && kyc.lastName.length > 0) {
    return Object.freeze({
      firstName: kyc.firstName,
      lastName: kyc.lastName,
    });
  }
  const fullName = kyc.fullName;
  if (typeof fullName === 'string' && fullName.length > 0) {
    try {
      const parsed = parseFullName(fullName);
      return Object.freeze({
        firstName: parsed.firstName,
        lastName: parsed.lastName,
      });
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// handleStartAddress
// ---------------------------------------------------------------------------

/**
 * POST /api/customer/kyc/start-address
 *
 * Create a Didit address verification session (phase 2: proof of address).
 * Requires identity + biometric to be completed first (kyc_3 or higher).
 */
export async function handleStartAddress(
  ctx: CustomerContext,
  continueUrl: string | null = null,
): Promise<NextResponse> {
  const { customer, db, now } = ctx;
  const safeContinueUrl = sanitizeContinueUrl(continueUrl);

  // --- 0. Sprint 6 — IP-abuse pre-Didit gate ---
  //
  // Symmetric to `handleStartIdentity`. The IP-abuse counter is
  // shared across phases; a 3-strike IP can't slip into the system
  // by jumping straight to address phase if identity was somehow
  // already completed (or if a future flow lets address run
  // independently). 503 short-circuits BEFORE we go to Didit.
  const ipHash = hashIp(ctx.ip);
  if (ipHash.length > 0) {
    try {
      const overThreshold = await isIpOverThreshold(db, ipHash);
      if (overThreshold) {
        await writeAudit(db, {
          action: 'fraud.repeat_evader_detected',
          actor: systemActor('ip-abuse-gate'),
          target: uuidTarget({ kind: 'customer', id: customer.id }),
          context: buildAuditRequestContext({
            ip: ctx.ip ?? null,
            userAgent: ctx.userAgent ?? null,
            requestId: ctx.requestId,
          }),
          meta: { ipHash, surface: 'start_address' },
          ts: now,
        }).catch(() => {
          // Audit-write failure must not flip the 503 into a 5xx.
        });
        return ctx.errorJson(
          'service_unavailable',
          'KYC verification is temporarily unavailable from your network. Please try again later.',
          503,
        );
      }
    } catch (ipErr) {
      getRootLogger().error(
        {
          event: 'ip_abuse_gate_check_failed',
          surface: 'start_address',
          err: ipErr instanceof Error
            ? { name: ipErr.name, message: ipErr.message }
            : String(ipErr),
        },
        'IP-abuse gate check failed — proceeding without gate',
      );
    }
  }

  // --- 0b. Per-customer decline gate ---
  //
  // Symmetric to `handleStartIdentity`. The counter is shared across
  // phases — a customer who burned their decline budget on identity
  // can't slip past by trying address. The reset path inside the
  // mint pipeline clears it on every approval, so the gate naturally
  // releases after a successful retry without admin intervention.
  const declineLock = evaluateDeclineLock(
    {
      consecutiveKycDeclines: customer.consecutiveKycDeclines,
      lastDeclineAt: customer.lastDeclineAt,
    },
    now,
  );
  if (declineLock.locked) {
    await writeAudit(db, {
      action: 'fraud.kyc_decline_locked',
      actor: systemActor('decline-counter-gate'),
      target: uuidTarget({ kind: 'customer', id: customer.id }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        surface: 'start_address',
        count: declineLock.count,
        threshold: declineLock.threshold,
        cooldownEndsAt: declineLock.cooldownEndsAt?.toISOString() ?? null,
      },
      ts: now,
    }).catch(() => {
      // Audit-write failure must not flip the 429 into a 5xx.
    });
    return ctx.json(
      {
        error: {
          code: 'kyc_decline_locked',
          message:
            'Too many failed verification attempts. Please wait before trying again.',
          cooldownEndsAt: declineLock.cooldownEndsAt?.toISOString() ?? null,
        },
      },
      429,
    );
  }

  // --- 1. Check customer status ---
  //
  // Note on Didit revoke (Batch E): a Didit-revoked customer is at
  // `kyc_level=kyc_0` (the user-entity webhook handler resets it).
  // The level check below requires `kyc_3+` for address verification,
  // so a stale tab from before the revoke is automatically rejected
  // with `kyc_level_ineligible` here — no extra guard needed.
  if (customer.status !== 'active') {
    return ctx.errorJson(
      'account_not_active',
      'Your account must be verified before starting address verification.',
      403,
    );
  }

  // --- 2. Check KYC level eligibility (Sprint 9: registry-driven) ---
  //
  // `ADDRESS_PHASE.eligibleStartLevels` is `['kyc_3']` — exactly the
  // single level at which address verification can begin (identity
  // is fully completed but address is not yet started). Levels
  // below kyc_3 mean identity isn't done; kyc_4 means address is
  // already verified. Identical SoT used by the OAuth fast path,
  // the /kyc UI step status, and the reconciler.
  const kycLevel = isCustomerKycLevel(customer.kycLevel)
    ? customer.kycLevel
    : 'kyc_0' as CustomerKycLevel;

  if (!ADDRESS_PHASE.eligibleStartLevels.includes(kycLevel)) {
    return ctx.errorJson(
      'kyc_level_ineligible',
      'Identity and biometric verification must be completed before address verification.',
      409,
    );
  }

  // --- 2b. Wallet gate (FHE design invariant) ---
  //
  // Mirror `handleStartIdentity`. A kyc_3 customer had a wallet at
  // identity-mint time, so a missing wallet here means they unlinked it
  // between phases — refuse rather than let the address-phase pipeline
  // throw at mint. (Same-wallet consistency across phases is enforced
  // separately in the pipeline; here we only require that *a* wallet is
  // linked so the credential remains user-owned.)
  {
    const { getCustomerWalletAddress } = await import('@/lib/fhe/customer-address');
    const walletAddress = await getCustomerWalletAddress(db, customer.id);
    if (walletAddress === null) {
      return ctx.errorJson(
        'wallet_not_linked',
        'Re-link your Ethereum wallet before address verification — your credential is owned by and decryptable only with your wallet.',
        409,
      );
    }
  }

  // --- 3. Load Didit config (needed for the stale-URL check below) ---
  const diditConfig = loadDiditConfigSafe();
  if (diditConfig === null) {
    return ctx.errorJson(
      'service_unavailable',
      'KYC verification service is currently unavailable.',
      503,
    );
  }

  // --- 4. Resume existing active address session — same stale-URL
  //         contract as `handleStartIdentity`: a row whose URL is
  //         live for the current Didit hosted host is replayed; a
  //         row whose URL is null or points at the legacy host is
  //         expired in the locked tx below and replaced with a
  //         freshly-minted session.
  const activeAddressSessions = await db
    .select({
      id: schema.kycSessions.id,
      verificationUrl: schema.kycSessions.verificationUrl,
    })
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.customerId, customer.id),
        eq(schema.kycSessions.workflow, 'address'),
        inArray(schema.kycSessions.status, [...ACTIVE_SESSION_STATUSES]),
      ),
    )
    .limit(1);

  const existingAddress = activeAddressSessions[0];
  if (
    existingAddress !== undefined &&
    existingAddress.verificationUrl !== null &&
    !isStaleHostedUrl(existingAddress.verificationUrl, diditConfig.baseUrl)
  ) {
    return ctx.json(
      {
        sessionId: existingAddress.id,
        redirectUrl: existingAddress.verificationUrl,
        resumed: true,
      },
      200,
    );
  }

  // --- 5. Build vendor data ---
  const crivacySessionId = crypto.randomUUID();
  const vendorDataRaw = JSON.stringify({
    crivacySessionId,
    type: 'customer',
    customerId: customer.id,
  });
  const vendorData = validateVendorData(vendorDataRaw);

  // --- 6. Determine callback URL ---
  // Didit's `callback` field is the URL the user's browser is
  // redirected to after they finish the hosted flow — it is NOT a
  // webhook delivery target. Webhook (server-to-server, signed) is a
  // separately-configured channel in the Didit dashboard
  // (handled by `/api/webhooks/didit`). Pointing `callback` at our
  // webhook endpoint surfaces a useless API response to the user's
  // phone after verification; the correct destination is the public
  // `/kyc/callback` UX page that says "verification complete, return
  // to your computer". State propagation back to the desktop is
  // handled by the SSE pull-fallback + webhook (whichever wins).
  const appUrl = getAppUrl();
  const callbackUrl = `${appUrl}/kyc/callback`;

  // --- 6.5. Sprint 8 — Name anchor for PoA fuzzy match ---
  //
  // Without `expected_details.first_name + last_name` on the address
  // session create, Didit's PoA name match returns NULL and a roommate's
  // utility bill would slip through. We pull the name from the customer's
  // most recent approved identity session decision (re-fetched from Didit
  // — Sprint 1 PII purge means we don't store names locally).
  //
  // vendor_data is session-scoped (fresh crivacySessionId per session),
  // so `GET /v3/users/{vendor_data}/` won't aggregate across sessions
  // for the same customer. We use the identity session's diditSessionId
  // instead, which is stable in our DB.
  //
  // Fail-closed: if no approved identity session is found or its decision
  // doesn't contain a name, refuse to start the address session. The
  // kyc_level >= kyc_3 gate above already guarantees the row exists,
  // but defense-in-depth covers race + reset edge cases.
  const expectedDetails = await loadIdentityNameAnchor(db, diditConfig, customer.id);
  if (expectedDetails === null) {
    getRootLogger().warn(
      {
        event: 'address_name_anchor_unavailable',
        customerId: customer.id,
        kycLevel,
      },
      'No usable identity name found for address session — refusing to start',
    );
    return ctx.errorJson(
      'kyc_level_ineligible',
      'Identity verification record is incomplete. Please contact support.',
      409,
    );
  }

  // --- 7-8. Budget check + Didit call + INSERT — same BUG #56 race
  //          fix as `handleStartIdentity`. Cross-workflow budget is
  //          shared on purpose (Didit cost is identical), so we use
  //          the same advisory-lock key namespace per customer.
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const verdict = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'kyc_create:' + customer.id}))`,
    );

    // Inside-tx race+orphan guard — same contract as `handleStartIdentity`.
    // Catches double-click within 60s and approved-but-not-yet-minted
    // session restart attempts. Detail in `evaluateStartGuardInTx`.
    const guard = await evaluateStartGuardInTx(tx, customer.id, 'address', now, diditConfig);
    if (guard.kind === 'resume') {
      return { kind: 'resume' as const, sessionId: guard.sessionId, redirectUrl: guard.redirectUrl };
    }
    if (guard.kind === 'mint_pending') {
      return { kind: 'mint_pending' as const };
    }

    // Clear any leftover active address row — see the matching
    // comment in `handleStartIdentity`. Frees the partial unique
    // index slot for the INSERT below.
    await tx
      .update(schema.kycSessions)
      .set({ status: 'expired', updatedAt: now })
      .where(
        and(
          eq(schema.kycSessions.customerId, customer.id),
          eq(schema.kycSessions.workflow, 'address'),
          inArray(schema.kycSessions.status, [...ACTIVE_SESSION_STATUSES]),
        ),
      );

    const budgetRows = await tx
      .select({ count: sql<string>`COUNT(*)::text` })
      .from(schema.kycSessions)
      .where(
        and(
          eq(schema.kycSessions.customerId, customer.id),
          sql`${schema.kycSessions.createdAt} > ${new Date(now.getTime() - MONTHLY_WINDOW_MS)}`,
        ),
      );
    const usedCount = Number.parseInt(budgetRows[0]?.count ?? '0', 10);
    if (usedCount >= MONTHLY_SESSION_CAP_PER_CUSTOMER) {
      return { kind: 'cap_exceeded' as const };
    }

    const diditResult = await createAddressSession(
      diditConfig,
      vendorData,
      callbackUrl,
      expectedDetails,
    );

    const insertedRows = await tx
      .insert(schema.kycSessions)
      .values({
        kind: 'customer',
        customerId: customer.id,
        workflow: 'address',
        status: 'pending',
        diditSessionId: diditResult.sessionId,
        diditWorkflowId: diditResult.workflowId,
        verificationUrl: diditResult.sessionUrl,
        // Sprint 9: persist the OAuth-resume continue URL — same
        // contract as `handleStartIdentity`. Callback page reads
        // `metadata.continueUrl` after Approved and redirects.
        ...(safeContinueUrl !== null
          ? { metadata: { continueUrl: safeContinueUrl } }
          : {}),
        expiresAt,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.kycSessions.id });
    const insertedRow = insertedRows[0];
    if (insertedRow === undefined) {
      return { kind: 'insert_failed' as const };
    }
    return { kind: 'ok' as const, sessionId: insertedRow.id, redirectUrl: diditResult.sessionUrl };
  });

  if (verdict.kind === 'resume') {
    return ctx.json(
      {
        sessionId: verdict.sessionId,
        redirectUrl: verdict.redirectUrl,
        resumed: true,
      },
      200,
    );
  }
  if (verdict.kind === 'mint_pending') {
    return ctx.errorJson(
      'kyc_mint_pending',
      'Address verification approved. We are finalizing your credential — please wait a few seconds before retrying.',
      409,
    );
  }
  if (verdict.kind === 'cap_exceeded') {
    return ctx.errorJson(
      'kyc_monthly_limit_exceeded',
      'You have reached the monthly verification limit. Please contact support if you need additional attempts.',
      429,
    );
  }
  if (verdict.kind === 'insert_failed') {
    return ctx.errorJson('internal_error', 'Failed to create address verification session.', 500);
  }

  // F-KYC-A2-A-003: kyc_started for the address phase. Same shape as
  // the identity-phase audit; the `phase` meta lets queries split on
  // Phase 1 vs Phase 2 without a join.
  await writeAudit(db, {
    action: 'customer.kyc_started',
    actor: customerActor({ id: customer.id, label: customerLabel({ email: customer.email, id: customer.id }) }),
    target: uuidTarget({ kind: 'customer', id: customer.id }),
    context: buildAuditRequestContext({
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId,
    }),
    meta: {
      sessionId: verdict.sessionId,
      workflow: 'address',
      phase: 'address',
    },
    ts: now,
  });

  return ctx.json(
    {
      sessionId: verdict.sessionId,
      redirectUrl: verdict.redirectUrl,
      resumed: false,
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// handleGetSession
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/kyc/session/[id]
 *
 * Returns details for a specific KYC session owned by the customer.
 */
export async function handleGetSession(
  ctx: CustomerContext,
  sessionId: string,
): Promise<NextResponse> {
  const { customer, db } = ctx;

  const rows = await db
    .select()
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.id, sessionId),
        eq(schema.kycSessions.customerId, customer.id),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return ctx.errorJson('not_found', 'KYC session not found.', 404);
  }

  return ctx.json({
    session: mapSessionRow(row),
  });
}

// ---------------------------------------------------------------------------
// handleCallbackStatus
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/kyc/callback-status?session=<diditSessionId>
 *
 * Sprint 9: callback page replacement for the optimistic
 * URL-`?status=` rendering. The customer's browser polls this endpoint
 * after Didit redirects them to `/kyc/callback`; the page only renders
 * the variant the registry maps from the REAL `kyc_sessions.status`,
 * never from the URL.
 *
 * Trust boundary
 * --------------
 * The Didit redirect URL is fully attacker-controllable (the user
 * could craft `/kyc/callback?status=Approved&verificationSessionId=...`
 * by hand), so this endpoint:
 *
 *   1. Requires the customer cookie (`customerRoute`). A phone
 *      handoff with no cookie cannot call this endpoint, so the
 *      callback page degrades gracefully (it shows the neutral
 *      "submitted" variant on 401).
 *
 *   2. Looks the session up by Didit session id AND owner — a
 *      cross-customer lookup returns 404 with no enumeration leak
 *      (single SELECT, no fingerprint timing because the verifier
 *      always reads + always responds in the same shape).
 *
 *   3. Treats the URL session id as untrusted: a 404 is the only
 *      response when ownership doesn't match, so an attacker can't
 *      probe for session-id existence.
 *
 * Side effect
 * -----------
 * If the session is in a `PULL_OVERWRITABLE_STATUSES` state (typically
 * pending / in_progress) the handler opportunistically calls
 * `pullAndApplyDiditDecision` so the callback page also serves as a
 * pull-fallback path. This catches the exact webhook-401 / drift case
 * Sprint 9 was opened for: even when the inbound webhook fails the
 * signature gate, the user landing on `/kyc/callback` will trigger a
 * Didit poll that updates the row and surfaces the real outcome to
 * the UI. The reconciler still runs as the every-15-min safety net
 * but no longer is the only path.
 *
 * Response shape
 * --------------
 * ```ts
 * {
 *   phase: 'identity' | 'address',
 *   sessionStatus: KycStatus,
 *   variant: 'approved' | 'in_review' | 'declined' | 'in_progress' | 'unknown',
 *   continueUrl: string | null,   // OAuth resume target if persisted
 *   isTerminal: boolean,           // page can stop polling on true
 * }
 * ```
 */
export async function handleCallbackStatus(
  ctx: CustomerContext,
  diditSessionId: string,
): Promise<NextResponse> {
  const { customer, db, now } = ctx;

  if (diditSessionId.length === 0 || diditSessionId.length > 256) {
    return ctx.errorJson(
      'validation_failed',
      'Invalid session identifier.',
      400,
    );
  }

  // Owner-scoped lookup. Single SELECT keyed on `(diditSessionId,
  // customerId)` so a cross-account probe returns the same 404 shape
  // a missing-row probe does — no enumeration timing leak.
  const rows = await db
    .select()
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.kind, 'customer' as const),
        eq(schema.kycSessions.diditSessionId, diditSessionId),
        eq(schema.kycSessions.customerId, customer.id),
      ),
    )
    .limit(1);

  let row = rows[0];
  if (row === undefined) {
    return ctx.errorJson('not_found', 'Verification session not found.', 404);
  }

  const phase = findPhaseByDiditWorkflow(row.workflow);
  if (phase === null || phase.diditWorkflow === null) {
    // Workflow value is not a Didit-driven phase — should not be
    // possible for a `kind='customer'` row but defends a future
    // schema loosening. Treat as unknown so the page falls into the
    // neutral "submitted" branch.
    return ctx.errorJson('not_found', 'Verification session not found.', 404);
  }

  // Opportunistic pull-fallback. Webhook may have been rejected
  // (e.g. signature mismatch) leaving the row stuck in a non-
  // terminal state; calling Didit here updates the row before we
  // tell the page anything. Throttled per customer via the same
  // map the SSE poll loop uses.
  if ((PULL_OVERWRITABLE_STATUSES as readonly string[]).includes(row.status)) {
    const lastPullMs = lastDiditPullByCustomer.get(customer.id) ?? 0;
    const elapsedSinceLastPull = Date.now() - lastPullMs;
    if (elapsedSinceLastPull >= DIDIT_PULL_THROTTLE_MS) {
      lastDiditPullByCustomer.set(customer.id, Date.now());
      const diditConfig = loadDiditConfigSafe();
      if (diditConfig !== null) {
        try {
          await pullAndApplyDiditDecision(db, asCustomerSession(row), now, diditConfig);
          // Re-read the row so the response reflects any state the
          // pull just persisted. A stale read here is the bug we
          // are explicitly preventing — the page would then show
          // an out-of-date variant.
          const reread = await db
            .select()
            .from(schema.kycSessions)
            .where(
              and(
                eq(schema.kycSessions.kind, 'customer' as const),
                eq(schema.kycSessions.id, row.id),
              ),
            )
            .limit(1);
          if (reread[0] !== undefined) {
            row = reread[0];
          }
        } catch (err) {
          // Pull failure is non-fatal: the page still gets the
          // current row state and can keep polling. Log loud so
          // the SOC sees stuck-pull patterns.
          getRootLogger().warn(
            {
              event: 'callback_status_pull_failed',
              sessionId: row.id,
              err:
                err instanceof Error
                  ? { name: err.name, message: err.message }
                  : String(err),
            },
            'Callback status: opportunistic pull-fallback failed; serving current row',
          );
        }
      }
    }
  }

  const sessionStatus = row.status as KycStatus;
  const variant =
    phase.resolveCallbackVariant !== null
      ? phase.resolveCallbackVariant(sessionStatus)
      : 'unknown';

  // `kyc_sessions.metadata.continueUrl` is set at start time when
  // the OAuth fast path or a deep-link entry points the user back
  // to a specific surface after KYC completes. Same-origin guard
  // already happens at write time (start handlers), but defended
  // again here on read so a future bypass at write doesn't expose
  // an open redirect.
  const continueUrl = readContinueUrlFromMetadata(row.metadata);
  const isTerminal = variant === 'approved' || variant === 'declined' || variant === 'in_review';

  return ctx.json({
    phase: phase.id,
    sessionStatus,
    variant,
    continueUrl,
    isTerminal,
  });
}

// ---------------------------------------------------------------------------
// handlePublicCallbackStatus — bearer-only variant lookup for phone handoff
// ---------------------------------------------------------------------------

/**
 * Public sibling of {@link handleCallbackStatus} — same registry-driven
 * variant resolution, but keyed only on the Didit session id (treated
 * as a bearer token: the caller proves they came from Didit's redirect
 * by holding the unguessable UUID).
 *
 * Why exists: the phone-handoff path opens `/kyc/callback` on a device
 * with no Crivacy session cookie (the QR scan only carries the Didit
 * verification, not the Crivacy login). The auth-gated callback-status
 * endpoint correctly returns 401 for that device — but the page then
 * falls into the neutral "Verification submitted" branch even when
 * the actual outcome was DECLINED. The mobile user gets misleading
 * copy claiming success.
 *
 * Trade-off: anyone holding the `verificationSessionId` learns the
 * verification outcome (approved/declined/in_review/in_progress). The
 * id is a 16-byte UUID generated by Didit, never embedded in shareable
 * URLs by us, and the variant alone leaks no PII (no name / no
 * decline reason / no continue URL). Acceptable for the UX win.
 *
 * Pull-fallback: the public surface MUST drive convergence on its own
 * — the original "rely on desktop / webhook / reconciler" assumption
 * fell over for the common case of (a) phone hitting `/kyc/callback`
 * before the webhook has landed, (b) webhook delayed by Didit-side
 * processing, or (c) webhook signature mismatch leaving the row stuck.
 * In all three the phone would poll a non-terminal row until the
 * 30-s page timeout and surface "Still processing" — a confusing
 * outcome for a customer who actually completed verification on the
 * device they are looking at.
 *
 * Throttle key is the session row's `customerId` (NOT the bearer
 * session id) so the customer-wide Didit budget ceiling stays
 * authoritative — desktop SSE pulls + auth'd callback pulls + public
 * phone pulls all share the same `lastDiditPullByCustomer` map and
 * cannot collectively burn budget faster than one pull per
 * {@link DIDIT_PULL_THROTTLE_MS}. A stranger holding a leaked id
 * therefore cannot escalate Didit spend beyond the legitimate owner's
 * own ceiling.
 *
 * Response is intentionally a strict subset of the auth'd version:
 * no `phase`, no `sessionStatus`, no `continueUrl` — only `variant`
 * + `isTerminal`. Callers needing the richer response must
 * authenticate.
 */
export async function handlePublicCallbackStatus(
  db: CrivacyDatabase,
  diditSessionId: string,
  now: Date = new Date(),
): Promise<NextResponse> {
  if (typeof diditSessionId !== 'string') {
    return NextResponseClass.json(
      { error: { code: 'validation_failed', message: 'Invalid session identifier.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  if (diditSessionId.length === 0 || diditSessionId.length > 256) {
    return NextResponseClass.json(
      { error: { code: 'validation_failed', message: 'Invalid session identifier.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  // Bearer-only lookup. Must still scope to `kind='customer'` so
  // B2B sessions (firm-issued via API key) are invisible to the
  // public surface. Selects the full row so the pull-fallback below
  // can hand it to `pullAndApplyDiditDecision` and re-read the row
  // afterward — same pattern as the auth'd callback-status path.
  const rows = await db
    .select()
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.kind, 'customer' as const),
        eq(schema.kycSessions.diditSessionId, diditSessionId),
      ),
    )
    .limit(1);

  let row = rows[0];
  if (row === undefined) {
    return NextResponseClass.json(
      { error: { code: 'not_found', message: 'Verification session not found.' } },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }

  const phase = findPhaseByDiditWorkflow(row.workflow);
  if (phase === null || phase.resolveCallbackVariant === null) {
    return NextResponseClass.json(
      { error: { code: 'not_found', message: 'Verification session not found.' } },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }

  // Opportunistic pull-fallback — same predicate, helper, throttle map
  // and re-read pattern the auth'd `handleCallbackStatus` uses, so the
  // phone surface converges on Didit's decision without waiting for
  // the webhook or the desktop tab. Throttle keyed on the row's
  // customerId (not the bearer session id) so the budget ceiling is
  // customer-wide and a leaked id cannot escalate Didit spend.
  if (
    row.customerId !== null &&
    (PULL_OVERWRITABLE_STATUSES as readonly string[]).includes(row.status)
  ) {
    const customerId = row.customerId;
    const lastPullMs = lastDiditPullByCustomer.get(customerId) ?? 0;
    const elapsedSinceLastPull = Date.now() - lastPullMs;
    if (elapsedSinceLastPull >= DIDIT_PULL_THROTTLE_MS) {
      // Set the throttle BEFORE the await so a parallel phone poll
      // on the same session doesn't race a duplicate pull.
      lastDiditPullByCustomer.set(customerId, Date.now());
      const diditConfig = loadDiditConfigSafe();
      if (diditConfig !== null) {
        try {
          await pullAndApplyDiditDecision(db, asCustomerSession(row), now, diditConfig);
          const reread = await db
            .select()
            .from(schema.kycSessions)
            .where(
              and(
                eq(schema.kycSessions.kind, 'customer' as const),
                eq(schema.kycSessions.id, row.id),
              ),
            )
            .limit(1);
          if (reread[0] !== undefined) {
            row = reread[0];
          }
        } catch (err) {
          // Same non-fatal pattern as the auth'd path — log loud,
          // serve current state, let the page keep polling.
          getRootLogger().warn(
            {
              event: 'public_callback_status_pull_failed',
              sessionId: row.id,
              err:
                err instanceof Error
                  ? { name: err.name, message: err.message }
                  : String(err),
            },
            'Public callback status: opportunistic pull-fallback failed; serving current row',
          );
        }
      }
    }
  }

  const variant = phase.resolveCallbackVariant(row.status as KycStatus);
  const isTerminal =
    variant === 'approved' || variant === 'declined' || variant === 'in_review';

  return NextResponseClass.json(
    { variant, isTerminal },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Strict same-origin guard for the OAuth-resume `continueUrl`. Only
 * accepts a string starting with a single `/` (rejects
 * protocol-relative `//evil.com` and absolute URLs). Same rule the
 * `/kyc` page applies to its `?continue=` query parameter and the
 * login `from=` redirect — single SoT for "is this a safe inbound
 * redirect target?". Used at write-time (start handlers) AND at
 * read-time (callback-status handler) so a future regression at one
 * site cannot turn the system into an open-redirect surface.
 */
function sanitizeContinueUrl(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw.length === 0) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  return raw;
}

/**
 * Read the persisted `continueUrl` off a `kyc_sessions.metadata`
 * blob, applying the same same-origin guard as the writer.
 */
function readContinueUrlFromMetadata(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>)['continueUrl'];
  return sanitizeContinueUrl(typeof raw === 'string' ? raw : null);
}

// ---------------------------------------------------------------------------
// handleResumeSession
// ---------------------------------------------------------------------------

/**
 * POST /api/customer/kyc/session/[id]/resume
 *
 * Resume or check the status of an existing KYC session. If the session
 * is still in progress, this endpoint polls Didit for a decision update.
 *
 * Returns:
 *   - For terminal sessions (approved/rejected/revoked): final result
 *   - For expired sessions: error suggesting to start a new session
 *   - For active sessions: current status + redirect URL (after polling Didit)
 */
export async function handleResumeSession(
  ctx: CustomerContext,
  sessionId: string,
): Promise<NextResponse> {
  const { customer, db, now } = ctx;

  // --- 1. Find session ---
  const rows = await db
    .select()
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.id, sessionId),
        eq(schema.kycSessions.customerId, customer.id),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return ctx.errorJson('not_found', 'KYC session not found.', 404);
  }

  // --- 2. Handle terminal statuses ---
  if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
    return ctx.json({
      session: mapSessionRow(row),
      terminal: true,
    });
  }

  // --- 3. Handle expired sessions ---
  if (row.expiresAt < now) {
    // Mark as expired if not already
    if (row.status !== 'expired') {
      await db
        .update(schema.kycSessions)
        .set({ status: 'expired', completedAt: now, updatedAt: now })
        .where(eq(schema.kycSessions.id, row.id));
    }

    return ctx.errorJson(
      'session_expired',
      'This verification session has expired. Please start a new verification.',
      410,
    );
  }

  // --- 4. Poll Didit for status update (if we have a Didit session ID) ---
  if (row.diditSessionId !== null) {
    const diditConfig = loadDiditConfigSafe();
    if (diditConfig !== null) {
      try {
        const diditSessionId = asDiditSessionIdUnchecked(row.diditSessionId);
        const decision = await getDecision(diditConfig, diditSessionId);

        // Update the local row if Didit has a terminal decision
        if (decision.status === 'Approved') {
          await db
            .update(schema.kycSessions)
            .set({
              status: row.workflow === 'identity' ? 'identity_approved' : 'approved',
              diditDecisionPayload: decision as unknown as Record<string, unknown>,
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(schema.kycSessions.id, row.id));

          // Enqueue the credential pipeline job — the webhook may have
          // missed or already be processing. The singletonKey in the job
          // options deduplicates so this is safe to call more than once.
          try {
            await enqueueCredentialPipelineFromResume(
              row.id,
              customer.id,
              row.diditSessionId!,
              row.workflow === 'identity' ? 'identity' : 'address',
            );
          } catch (enqueueErr) {
            // Non-critical — log and continue. The webhook path may
            // have already enqueued the job successfully.
            getRootLogger().error(
              {
                event: 'customer_kyc_resume_enqueue_failed',
                err: enqueueErr instanceof Error
                  ? { name: enqueueErr.name, message: enqueueErr.message }
                  : String(enqueueErr),
              },
              'Failed to enqueue credential pipeline from resume',
            );
          }

          const updatedRow = { ...row, status: row.workflow === 'identity' ? 'identity_approved' as const : 'approved' as const };
          return ctx.json({
            session: mapSessionRow({ ...row, ...updatedRow, completedAt: now }),
            terminal: true,
          });
        }

        if (decision.status === 'Declined') {
          // Sprint 6: prefer the priority-resolved warning description.
          const declineReason =
            decision.failureReasonText ?? 'Verification declined by provider.';
          await db
            .update(schema.kycSessions)
            .set({
              status: 'rejected',
              diditDecisionPayload: decision as unknown as Record<string, unknown>,
              failureReason: declineReason,
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(schema.kycSessions.id, row.id));

          return ctx.json({
            session: mapSessionRow({
              ...row,
              status: 'rejected',
              failureReason: declineReason,
              completedAt: now,
            }),
            terminal: true,
          });
        }

        // Still in progress — update status if needed
        if (decision.status === 'In Progress' && row.status === 'pending') {
          await db
            .update(schema.kycSessions)
            .set({ status: 'in_progress', updatedAt: now })
            .where(eq(schema.kycSessions.id, row.id));
        }
      } catch {
        // Didit fetch failed — return current local state. The webhook will
        // eventually deliver the decision. This is a non-critical error.
      }
    }
  }

  // --- 5. Return current status ---
  return ctx.json({
    session: mapSessionRow(row),
    terminal: false,
  });
}

// ---------------------------------------------------------------------------
// handleGetCredential
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/kyc/credential
 *
 * Returns a summary of the customer's KYC credential derived from their
 * current level and score. The actual credential is managed
 * separately; this endpoint provides the UI with display data.
 */
export async function handleGetCredential(ctx: CustomerContext): Promise<NextResponse> {
  const { customer, db } = ctx;

  const kycLevel = isCustomerKycLevel(customer.kycLevel)
    ? customer.kycLevel
    : 'kyc_0' as CustomerKycLevel;

  // Load the active credential row to surface NFT metadata + chain
  // anchors. The customer table only stores the derived KYC level /
  // score; the on-chain artefact lives in `kyc_credentials_meta`.
  // For Basic credentials there's no NFT (Enhanced-only mint), so the
  // `nft` field of the response stays null.
  const credentialRows = await db
    .select({
      id: schema.kycCredentialsMeta.id,
      level: schema.kycCredentialsMeta.level,
      chainContractId: schema.kycCredentialsMeta.chainContractId,
      chainNetwork: schema.kycCredentialsMeta.chainNetwork,
      validUntil: schema.kycCredentialsMeta.validUntil,
      confirmedAt: schema.kycCredentialsMeta.confirmedAt,
      nftContractId: schema.kycCredentialsMeta.nftContractId,
      nftMintedAt: schema.kycCredentialsMeta.nftMintedAt,
      nftBurnedAt: schema.kycCredentialsMeta.nftBurnedAt,
    })
    .from(schema.kycCredentialsMeta)
    .where(
      and(
        eq(schema.kycCredentialsMeta.userRef, customer.id),
        eq(schema.kycCredentialsMeta.status, 'active'),
      ),
    )
    .orderBy(desc(schema.kycCredentialsMeta.createdAt))
    .limit(1);

  const credential = credentialRows[0];

  let nft: {
    readonly contractId: string;
    readonly serialNumber: string;
    readonly displayName: string;
    readonly image: string;
    readonly mintedAt: string;
  } | null = null;

  if (
    credential !== undefined &&
    credential.nftContractId !== null &&
    credential.nftBurnedAt === null &&
    credential.nftMintedAt !== null
  ) {
    // Read the NFT artefact directly from chain. The `uri` field on the
    // soulbound `CrivacyKycNFT` token was written immutably at mint time
    // (Nouns / Loot pattern: inline base64 SVG, on-chain truth). Reading
    // rather than re-rendering avoids template-drift between the UI and the
    // on-chain artefact: a post-launch branding tweak does not retroactively
    // re-skin credentials minted before it. `nftContractId` stores the ERC-721
    // token id.
    const issuedIsoFallback = (credential.nftMintedAt ?? credential.confirmedAt ?? new Date()).toISOString();
    try {
      const { getFheClient } = await import('@crivacy-fhe/credential');
      const meta = await getFheClient().getNftMeta(BigInt(credential.nftContractId));
      if (meta !== null) {
        nft = {
          contractId: credential.nftContractId,
          serialNumber: meta.serialNumber,
          displayName: meta.displayName,
          image: meta.uri,
          mintedAt: meta.issuedAt.toISOString(),
        };
      } else {
        // Token not found on chain — likely cascade-burned after the bound
        // credential was revoked but the local meta hasn't caught up yet. Fall
        // back to derived fields and skip the image; UI shows metadata only.
        const serial = `crv-${credential.id.slice(0, 8)}`;
        nft = {
          contractId: credential.nftContractId,
          serialNumber: serial,
          displayName: `Crivacy KYC Verified - Enhanced ${serial}`,
          image: '',
          mintedAt: issuedIsoFallback,
        };
      }
    } catch (err) {
      // Chain fetch failure is non-fatal — the rest of the response
      // still shows the credential level/status.
      getRootLogger().error(
        {
          event: 'nft_chain_fetch_failed',
          credentialId: credential.id,
          tokenId: credential.nftContractId,
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        },
        'NFT chain fetch failed',
      );
    }
  }

  return ctx.json({
    level: kycLevel,
    levelName: kycLevelName(kycLevel),
    score: customer.kycScore,
    maxScore: MAX_SCORE,
    status: kycLevel === 'kyc_0' ? 'none' : 'active',
    nft,
  });
}

// ---------------------------------------------------------------------------
// handleKycEvents
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/kyc/events
 *
 * Opens a Server-Sent Events stream that pushes KYC status updates to
 * the customer's browser in real time. The stream sends:
 *
 *   - An initial `kyc.status_changed` event with the current state.
 *   - A heartbeat comment every 30 seconds to keep the connection alive.
 *   - A polling check every 5 seconds that sends `kyc.status_changed`
 *     when a session transition is detected.
 *
 * The stream is closed when the client disconnects (TCP FIN / RST).
 *
 * NOTE: This returns a raw `Response` (not `NextResponse`) because SSE
 * streams use a ReadableStream body.
 */
export async function handleKycEvents(ctx: CustomerContext): Promise<Response> {
  const { customer, db } = ctx;

  // --- Per-customer connection cap -----------------------------------
  //
  // SSE streams here are long-lived (heartbeat + poll + 10-min
  // hard cap) and each one holds a DB poll timer, so an unbounded
  // number of concurrent connections for the same customer turns
  // into a cheap single-tenant DoS against the DB pool. Reject
  // anything above `MAX_SSE_CONNECTIONS_PER_CUSTOMER` with a 429 +
  // `Retry-After`; legitimate clients only need two-three tabs and
  // a well-behaved EventSource backs off on 429 automatically.
  //
  // The check runs BEFORE the stream is created so a rejected
  // caller never opens a socket we have to clean up later.
  if (activeSseCount(customer.id) >= MAX_SSE_CONNECTIONS_PER_CUSTOMER) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'too_many_connections',
          message: `Too many active KYC event streams for this account (max ${MAX_SSE_CONNECTIONS_PER_CUSTOMER} concurrent). Close an existing tab and retry.`,
          requestId: ctx.requestId,
        },
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'Cache-Control': 'no-store',
          'x-request-id': ctx.requestId,
        },
      },
    );
  }

  // Reserve the slot BEFORE opening the stream so two parallel
  // `GET /api/customer/kyc/events` calls at the boundary both see
  // their own increment rather than racing the check above.
  incrementActiveSse(customer.id);

  // Hoist timer handles so the cancel callback below can clear them
  // synchronously when the client drops. Without this, the cancel
  // path released the connection slot but left both intervals
  // ticking — heartbeat (30 s) and poll (5 s, with a DB query) —
  // until the 10-minute safety timeout. A scripted client that
  // opens N tabs and immediately closes them therefore left N
  // dead poll loops draining the DB pool for ten minutes per loop.
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let safetyTimeout: ReturnType<typeof setTimeout> | null = null;

  const cleanupTimers = (): void => {
    if (heartbeatInterval !== null) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (safetyTimeout !== null) {
      clearTimeout(safetyTimeout);
      safetyTimeout = null;
    }
  };

  const { response, writer } = createSSEStream({
    headers: { 'x-request-id': ctx.requestId },
    // Fires exactly once from any teardown path (client disconnect,
    // server close, write failure after the socket went away). All
    // three route to this callback so the counter can never leak —
    // an orphan slot here eventually throttles legitimate re-
    // connects from the same customer. Also tears down the
    // heartbeat + poll intervals so they stop the moment the
    // socket does, not 10 minutes later.
    onCancel: () => {
      cleanupTimers();
      decrementActiveSse(customer.id);
    },
  });

  // --- Send initial state ---
  const initialSessions = await db
    .select()
    .from(schema.kycSessions)
    .where(eq(schema.kycSessions.customerId, customer.id))
    .orderBy(desc(schema.kycSessions.createdAt))
    .limit(10);

  const kycLevel = isCustomerKycLevel(customer.kycLevel)
    ? customer.kycLevel
    : 'kyc_0' as CustomerKycLevel;

  // Send current state for each active session, or a summary if none
  if (initialSessions.length > 0) {
    const latestSession = initialSessions[0]!;
    const statusData: KycStatusChangedData = {
      sessionId: latestSession.id,
      workflow: latestSession.workflow,
      status: latestSession.status,
      kycLevel,
      kycScore: customer.kycScore,
    };
    writer.sendEvent(KYC_EVENTS.STATUS_CHANGED, statusData);
  } else {
    const statusData: KycStatusChangedData = {
      sessionId: '',
      workflow: 'identity',
      status: 'none',
      kycLevel,
      kycScore: customer.kycScore,
    };
    writer.sendEvent(KYC_EVENTS.STATUS_CHANGED, statusData);
  }

  // --- Track the last known status for change detection ---
  let lastKnownStatus: string | null = initialSessions.length > 0
    ? initialSessions[0]!.status
    : null;
  let lastKnownSessionId: string | null = initialSessions.length > 0
    ? initialSessions[0]!.id
    : null;
  /**
   * Per-connection watermark for handoff-consume detection. Initialised
   * to the connection-open instant so the first poll only emits when a
   * NEW consume happens after the SSE connection opened — older
   * already-consumed handoffs (e.g. a session the customer abandoned
   * yesterday) do not fire a stale event when the customer re-opens
   * the page tomorrow. Updated each tick with the latest consumedAt
   * we have observed.
   */
  let lastSeenHandoffConsumedAt: Date = ctx.now;

  // --- Heartbeat interval ---
  heartbeatInterval = setInterval(() => {
    writer.sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);

  // --- Polling interval for status changes ---
  pollInterval = setInterval(async () => {
    try {
      const currentSessions = await db
        .select({
          id: schema.kycSessions.id,
          workflow: schema.kycSessions.workflow,
          status: schema.kycSessions.status,
        })
        .from(schema.kycSessions)
        .where(eq(schema.kycSessions.customerId, customer.id))
        .orderBy(desc(schema.kycSessions.createdAt))
        .limit(1);

      const current = currentSessions[0];
      if (current === undefined) return;

      // ----- Pull-fallback: ask Didit for the decision when the row
      //       has been waiting and we have not asked recently. Throttle
      //       is shared per-customer (see DIDIT_PULL_THROTTLE_MS) so
      //       multiple tabs do not multiply the burn. Only runs for
      //       statuses where Didit is the source of truth (`pending`,
      //       `in_progress`); terminal / review / resubmission statuses
      //       are already authoritative on our side.
      //
      //       Self-heals two distinct failure modes:
      //         * Local dev: Didit's outbound webhook cannot reach a
      //           localhost / RFC 1918 origin, so the push channel is
      //           dead by definition — pull is the *only* path that
      //           surfaces the decision.
      //         * Production: a missed/expired-retry webhook leaves
      //           the row stuck pending; pull catches it on the next
      //           SSE tick.
      if ((PULLABLE_STATUSES as readonly string[]).includes(current.status)) {
        const lastPullMs = lastDiditPullByCustomer.get(customer.id) ?? 0;
        const elapsedSinceLastPull = Date.now() - lastPullMs;
        if (elapsedSinceLastPull >= DIDIT_PULL_THROTTLE_MS) {
          // Set the throttle BEFORE the await so a parallel poll on
          // another connection sees the in-flight pull and does not
          // race a duplicate.
          lastDiditPullByCustomer.set(customer.id, Date.now());
          const diditConfig = loadDiditConfigSafe();
          if (diditConfig !== null) {
            const fullRow = await db
              .select()
              .from(schema.kycSessions)
              .where(
                and(
                  eq(schema.kycSessions.kind, 'customer' as const),
                  eq(schema.kycSessions.id, current.id),
                ),
              )
              .limit(1);
            const fullSession = fullRow[0];
            if (fullSession !== undefined) {
              await pullAndApplyDiditDecision(
                db,
                asCustomerSession(fullSession),
                new Date(),
                diditConfig,
              );
              // The status-change branch below handles emitting the
              // event — re-read via `currentSessions` happens on the
              // next tick. We intentionally do NOT re-query inside
              // this tick to keep the poll cycle bounded and
              // predictable; one-tick latency for the event is
              // acceptable (POLL_INTERVAL_MS=5s) and avoids
              // re-entrant logic.
            }
          }
        }
      }

      // ----- Status change detection (existing behavior).
      const statusChanged = current.status !== lastKnownStatus;
      const sessionChanged = current.id !== lastKnownSessionId;

      if (statusChanged || sessionChanged) {
        lastKnownStatus = current.status;
        lastKnownSessionId = current.id;

        // Fetch fresh kycLevel and kycScore from the DB — the values
        // captured when the stream opened may be stale if the credential
        // pipeline updated the customer between polls.
        const freshCustomer = await db
          .select({ kycLevel: schema.customers.kycLevel, kycScore: schema.customers.kycScore })
          .from(schema.customers)
          .where(eq(schema.customers.id, customer.id))
          .limit(1);

        const freshLevel = freshCustomer[0]?.kycLevel ?? kycLevel;
        const freshScore = freshCustomer[0]?.kycScore ?? customer.kycScore;

        const statusData: KycStatusChangedData = {
          sessionId: current.id,
          workflow: current.workflow,
          status: current.status,
          kycLevel: freshLevel,
          kycScore: freshScore,
        };
        writer.sendEvent(KYC_EVENTS.STATUS_CHANGED, statusData);
      }

      // ----- Handoff-consume detection: query the most recently
      //       consumed device handoff for this customer's sessions; if
      //       its consumedAt is newer than the watermark we set when
      //       the SSE connection opened, emit `kyc.handoff_consumed`.
      //       This is the moment the desktop knows "the user is now in
      //       the Didit flow on their phone" so the UI can swap the QR
      //       card for a "verification opened on your phone, continue
      //       there" panel. Sessions filter is restricted to the
      //       authenticated customer via the owned-sessions subquery,
      //       so the event leak surface is exactly the customer's own
      //       handoffs.
      const recentlyConsumed = await db
        .select({
          sessionId: schema.kycDeviceHandoffs.sessionId,
          consumedAt: schema.kycDeviceHandoffs.consumedAt,
        })
        .from(schema.kycDeviceHandoffs)
        .innerJoin(
          schema.kycSessions,
          eq(schema.kycDeviceHandoffs.sessionId, schema.kycSessions.id),
        )
        .where(
          and(
            eq(schema.kycSessions.customerId, customer.id),
            sql`${schema.kycDeviceHandoffs.consumedAt} > ${lastSeenHandoffConsumedAt}`,
          ),
        )
        .orderBy(desc(schema.kycDeviceHandoffs.consumedAt))
        .limit(1);

      const newConsume = recentlyConsumed[0];
      if (newConsume !== undefined && newConsume.consumedAt !== null) {
        lastSeenHandoffConsumedAt = newConsume.consumedAt;
        const handoffData: KycHandoffConsumedData = {
          sessionId: newConsume.sessionId,
        };
        writer.sendEvent(KYC_EVENTS.HANDOFF_CONSUMED, handoffData);
      }
    } catch {
      // DB query failed — skip this poll cycle. The next interval
      // will retry. Do not tear down the stream for transient errors.
    }
  }, POLL_INTERVAL_MS);

  // --- Clean up when the client disconnects ---
  // Two layers of cleanup, both routed through `cleanupTimers` so
  // there is exactly one tear-down path:
  //   1. ReadableStream cancel (client TCP FIN/RST or write
  //      failure mid-stream) → `onCancel` above fires synchronously,
  //      clears intervals, decrements the slot.
  //   2. Safety timeout → hard cap at 10 minutes for streams the
  //      socket never closes (e.g. half-open NAT). Calls the same
  //      cleanup path before issuing `writer.close()`, which itself
  //      triggers the cancel hook and the second-time guards inside
  //      `cleanupTimers` keep it idempotent.
  const maxStreamDurationMs = 10 * 60 * 1000; // 10 minutes
  safetyTimeout = setTimeout(() => {
    cleanupTimers();
    writer.close();
  }, maxStreamDurationMs);

  return response;
}

// ---------------------------------------------------------------------------
// handleCreateHandoff
// ---------------------------------------------------------------------------

/** Maximum number of handoff tokens per KYC session (rate limit). */
const MAX_HANDOFFS_PER_SESSION = 5;

/** Handoff token TTL: 10 minutes. */
const HANDOFF_TTL_MS = 10 * 60 * 1000;

/**
 * POST /api/customer/kyc/handoff
 *
 * Generate a one-time device handoff token for the customer's active KYC
 * session. Returns a QR code data URL, the raw handoff URL, and the expiry
 * time. The customer scans the QR code on their mobile device to continue
 * the biometric verification flow.
 *
 * Preconditions:
 *   - Customer must have an active KYC session (pending or in_progress).
 *   - Max 5 handoff tokens per session (rate limit).
 */
export async function handleCreateHandoff(ctx: CustomerContext): Promise<NextResponse> {
  const { customer, db, now } = ctx;

  // --- 1. Find the active KYC session ---
  const activeSessions = await db
    .select()
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.customerId, customer.id),
        inArray(schema.kycSessions.status, ['pending', 'in_progress']),
      ),
    )
    .orderBy(desc(schema.kycSessions.createdAt))
    .limit(1);

  const activeSession = activeSessions[0];
  if (activeSession === undefined) {
    return ctx.errorJson(
      'no_active_session',
      'No active KYC session found. Please start a verification first.',
      404,
    );
  }

  // --- 2. Rate limit: max 5 handoffs per session ---
  const existingHandoffs = await db
    .select({ id: schema.kycDeviceHandoffs.id })
    .from(schema.kycDeviceHandoffs)
    .where(
      and(
        eq(schema.kycDeviceHandoffs.sessionId, activeSession.id),
        isNull(schema.kycDeviceHandoffs.consumedAt),
      ),
    );

  if (existingHandoffs.length >= MAX_HANDOFFS_PER_SESSION) {
    return ctx.errorJson(
      'handoff_rate_limit',
      'Too many handoff tokens generated for this session. Please wait for existing tokens to expire.',
      429,
    );
  }

  // --- 3. Generate token ---
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(now.getTime() + HANDOFF_TTL_MS);

  // --- 4. Persist handoff row ---
  await db.insert(schema.kycDeviceHandoffs).values({
    customerId: customer.id,
    sessionId: activeSession.id,
    handoffTokenHash: tokenHash,
    expiresAt,
    createdAt: now,
  });

  // --- 5. Build handoff URL and QR code ---
  const appUrl = getAppUrl();
  const handoffUrl = `${appUrl}/kyc/handoff/${rawToken}`;
  const qrDataUrl = await QRCode.toDataURL(handoffUrl, {
    width: 256,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });

  return ctx.json({
    token: rawToken,
    qrDataUrl,
    handoffUrl,
    expiresAt: expiresAt.toISOString(),
  }, 201);
}

// ---------------------------------------------------------------------------
// handleConsumeHandoff
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/kyc/handoff/[token]
 *
 * PUBLIC route (no auth needed — the token IS the authentication).
 *
 * Consumes a device handoff token: verifies it is valid, not expired, not
 * already consumed, and returns the Didit redirect URL for the associated
 * KYC session so the mobile device can continue the verification flow.
 */
export async function handleConsumeHandoff(
  ctx: RequestContext,
  token: string,
): Promise<NextResponse> {
  const { db, now } = ctx;

  // --- 1. Hash the token ---
  const tokenHash = createHash('sha256').update(token).digest('hex');

  // --- 2. Look up the handoff row ---
  const handoffRows = await db
    .select()
    .from(schema.kycDeviceHandoffs)
    .where(eq(schema.kycDeviceHandoffs.handoffTokenHash, tokenHash))
    .limit(1);

  const handoff = handoffRows[0];
  if (handoff === undefined) {
    return ctx.errorJson('invalid_token', 'Invalid or expired handoff token.', 404);
  }

  // --- 3. Pre-check expiry (cheap, doesn't need a write) ---
  if (handoff.expiresAt < now) {
    return ctx.errorJson('token_expired', 'This handoff token has expired. Please generate a new one.', 410);
  }

  // --- 4. Atomic CAS consume ---
  //
  // `UPDATE ... WHERE consumed_at IS NULL RETURNING` flips the column
  // for exactly one writer. Two parallel callers that both observed
  // `consumedAt === null` at step 2 race here: only the writer whose
  // UPDATE found the row still NULL gets a returned row; every other
  // writer gets an empty result and reports `token_consumed`. This
  // matches `markAuthorizationRequestCompleted` (oauth-cancel) so the
  // single-shot guarantee is identical across the two consumer
  // surfaces.
  const userAgent = ctx.userAgent ?? 'unknown';
  const claimed = await db
    .update(schema.kycDeviceHandoffs)
    .set({
      consumedAt: now,
      deviceInfo: userAgent,
    })
    .where(
      and(
        eq(schema.kycDeviceHandoffs.id, handoff.id),
        isNull(schema.kycDeviceHandoffs.consumedAt),
      ),
    )
    .returning({ id: schema.kycDeviceHandoffs.id });
  if (claimed.length === 0) {
    return ctx.errorJson('token_consumed', 'This handoff token has already been used.', 410);
  }

  // --- 5. Look up the associated KYC session ---
  const sessionRows = await db
    .select()
    .from(schema.kycSessions)
    .where(eq(schema.kycSessions.id, handoff.sessionId))
    .limit(1);

  const session = sessionRows[0];
  if (session === undefined) {
    return ctx.errorJson('session_not_found', 'Associated KYC session not found.', 404);
  }

  // --- 6. Build redirect URL ---
  // Use the persisted Didit hosted URL — see `mapSessionRow` for why
  // we never reconstruct from `diditSessionId`. A row whose URL is
  // null (very old session pre-`verification_url` migration) yields
  // `null` here, and the device-handoff page falls back to its
  // existing "session not redirectable" branch.
  const redirectUrl = session.verificationUrl;

  return ctx.json({
    redirectUrl,
    sessionId: session.id,
  });
}

// ---------------------------------------------------------------------------
// Credential pipeline enqueue helper
// ---------------------------------------------------------------------------

/**
 * Enqueue a credential-pipeline job from the resume endpoint. Uses a
 * short-lived pg-boss connection; the singletonKey on the job ensures
 * idempotency if the webhook already enqueued the same job.
 */
async function enqueueCredentialPipelineFromResume(
  kycSessionId: string,
  customerId: string,
  diditSessionId: string,
  phase: 'identity' | 'address',
): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    getRootLogger().error(
      { event: 'customer_kyc_db_url_missing' },
      'DATABASE_URL not set, cannot enqueue credential pipeline',
    );
    return;
  }

  const { createQueueClient } = await import('@/server/jobs/queue');
  const { enqueueCredentialPipeline } = await import(
    '@/server/jobs/credential-pipeline-worker'
  );

  const boss = await createQueueClient(connectionString);
  try {
    await enqueueCredentialPipeline(boss, {
      kycSessionId,
      customerId,
      diditSessionId,
      phase,
    });
    getRootLogger().info(
      {
        event: 'customer_kyc_resume_pipeline_enqueued',
        customerId,
        kycSessionId,
        phase,
      },
      'Credential pipeline job enqueued from resume',
    );
  } finally {
    await boss.stop();
  }
}

// ---------------------------------------------------------------------------
// handleMintNft — user-triggered NFT mint
// ---------------------------------------------------------------------------

/**
 * POST /api/customer/credential/mint-nft
 *
 * User-triggered Enhanced KYC NFT mint. The credential itself is
 * auto-minted by `credential-pipeline-worker` once Didit confirms
 * address verification (kyc_4); the showcase NFT is minted only when
 * the customer clicks "Mint" on the /kyc step 4 surface, with their
 * chosen theme variant.
 *
 * Pre-conditions enforced server-side (UI gating is advisory):
 *   - Customer is authenticated.
 *   - An active credential exists for this customer.
 *   - Credential `level === 'enhanced'` (the on-chain contract also
 *     enforces this; we 409 fast for UX).
 *   - Credential `chainContractId IS NOT NULL` (chain-confirmed).
 *   - Credential `nftContractId IS NULL` (not already minted).
 *
 * Theme is a build-time parameter only — never persisted. The chosen
 * SVG bytes are written immutably onto chain in `KycNFT.image`; the
 * chain is the source of truth thereafter.
 *
 * Race protection: the post-mint UPDATE is a CAS guarded on
 * `nft_contract_id IS NULL` (see `claimCredentialNftMinted`). Two
 * parallel callers each succeed at chain create; only one wins the
 * UPDATE. The losing caller's NFT is an orphan on chain (logged for
 * future reconciler sweep). Also rate-limited per IP to make the
 * orphan case practically unreachable under normal load.
 */
export async function handleMintNft(ctx: CustomerContext): Promise<NextResponse> {
  const { customer, db, now } = ctx;
  const { z } = await import('zod');
  const { parseBody } = await import('@/server/middleware/parse');
  const { maybeRateLimitResponse } = await import('@/lib/auth-rate-limit');
  const { getFheClient } = await import('@crivacy-fhe/credential');
  const { getCustomerWalletAddress } = await import('@/lib/fhe/customer-address');
  const { buildEnhancedNftDataUri, deriveCustomerNo } = await import('@/lib/nft/build-nft');
  const { claimCredentialNftMinted } = await import('@/server/repositories/credentials');
  // `systemActor` already imported at top.

  // --- 1. Per-IP rate limit. Defence-in-depth over the CAS / advisory
  //         lock guards below — those handle correctness (one NFT per
  //         credential, no duplicate chain submits) but do not stop
  //         a stolen-session attacker from hammering the endpoint.
  const limited = await maybeRateLimitResponse(db, 'customer_mint_nft', ctx.ip, now);
  if (limited) return limited;

  // --- 2. Parse body. The theme is a closed enum — chain `ensure`
  //         doesn't enforce theme (it just sees SVG bytes), so the
  //         only client of theme is the SVG template selector. Closed
  //         union prevents arbitrary string drift if a future caller
  //         passes "Light" instead of "light".
  const MintNftBody = z.object({
    theme: z.enum(['light', 'dark']),
  });
  const body = await parseBody(ctx.request, MintNftBody);

  // --- 3. Pre-flight credential lookup (read-only, outside the lock
  //         tx). Catches the obvious "no active credential" / "wrong
  //         level" / "already minted" cases without paying for the
  //         lock. The authoritative re-check inside the lock tx is in
  //         step 5.
  const credentialRows = await db
    .select({
      id: schema.kycCredentialsMeta.id,
      level: schema.kycCredentialsMeta.level,
      chainContractId: schema.kycCredentialsMeta.chainContractId,
      chainNetwork: schema.kycCredentialsMeta.chainNetwork,
      nftContractId: schema.kycCredentialsMeta.nftContractId,
    })
    .from(schema.kycCredentialsMeta)
    .where(
      and(
        eq(schema.kycCredentialsMeta.userRef, customer.id),
        eq(schema.kycCredentialsMeta.status, 'active'),
      ),
    )
    .orderBy(desc(schema.kycCredentialsMeta.createdAt))
    .limit(1);

  const credential = credentialRows[0];
  if (credential === undefined) {
    return ctx.errorJson(
      'credential_not_found',
      'No active credential to mint an NFT for. Complete address verification first.',
      404,
    );
  }
  if (credential.level !== 'enhanced') {
    return ctx.errorJson(
      'credential_not_enhanced',
      'NFT is only available for Enhanced credentials. Complete address verification first.',
      409,
    );
  }
  if (credential.chainContractId === null) {
    return ctx.errorJson(
      'credential_not_on_chain',
      'Credential is not yet confirmed on chain. Please try again in a moment.',
      409,
    );
  }
  if (credential.nftContractId !== null) {
    return ctx.errorJson(
      'nft_already_minted',
      'NFT has already been minted for this credential.',
      409,
    );
  }

  // --- 4. Resolve the customer's on-chain address — the credential was
  //         issued to their EVM wallet earlier in the pipeline; the NFT is
  //         minted (soulbound) to the same address.
  const fhe = getFheClient();
  const userAddress = await getCustomerWalletAddress(db, customer.id);
  if (userAddress === null) {
    return ctx.errorJson(
      'wallet_not_linked',
      'Link an EVM wallet before minting your KYC pass.',
      409,
    );
  }

  // --- 5. Build the SVG with chosen theme. The output is a
  //         `data:image/svg+xml;base64,…` URI; DOMPurify sanitisation
  //         + 350 KB cap are inside `buildEnhancedNftDataUri`.
  const serial = `crv-${credential.id.slice(0, 8)}`;
  const displayName = `Crivacy KYC Verified - Enhanced ${serial}`;
  const image = await buildEnhancedNftDataUri({
    customerNo: deriveCustomerNo(customer.id),
    serial,
    issuedAt: now.toISOString(),
    partyId: `${userAddress.slice(0, 6)}…${userAddress.slice(-4)}`,
    theme: body.theme,
  });

  // --- 6. Acquire a tx-scoped advisory lock keyed on the credential id, then
  //         re-check NFT state inside the lock. Two concurrent mint requests
  //         for the same credential are serialised here — the second waits for
  //         the first tx to commit, re-reads `nftContractId`, and short-circuits
  //         with 409. The contract's own `tokenOfCustomer` guard reverts any
  //         duplicate on-chain mint, so orphan tokens are impossible by
  //         construction; this lock catches the wasted-tx case.
  let nftResult: { txHash: `0x${string}`; tokenId: bigint };
  try {
    nftResult = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'nft-mint:' + credential.id}))`,
      );

      const recheckRows = await tx
        .select({
          nftContractId: schema.kycCredentialsMeta.nftContractId,
          status: schema.kycCredentialsMeta.status,
        })
        .from(schema.kycCredentialsMeta)
        .where(eq(schema.kycCredentialsMeta.id, credential.id))
        .limit(1);
      const recheck = recheckRows[0];
      if (recheck === undefined || recheck.status !== 'active') {
        // Race lost: the credential was archived (revoked / superseded
        // / expired) while we waited for the lock. Surface as 409 —
        // the customer must restart the flow.
        throw new MintNftAbort('credential_not_active');
      }
      if (recheck.nftContractId !== null) {
        // Race lost to a concurrent winner. The NFT for this
        // credential already exists in DB; nothing to do.
        throw new MintNftAbort('nft_already_minted');
      }

      // --- 7. Mint the soulbound NFT on-chain inside the lock. The contract
      //         enforces Enhanced-only (via the caller) + one token per
      //         customer; a duplicate reverts.
      return await fhe.createKycNft({
        userAddress,
        serialNumber: serial,
        displayName,
        uri: image,
      });
    });
  } catch (err) {
    if (err instanceof MintNftAbort) {
      if (err.reason === 'credential_not_active') {
        return ctx.errorJson(
          'credential_not_active',
          'Credential is no longer active. Please refresh.',
          409,
        );
      }
      if (err.reason === 'nft_already_minted') {
        return ctx.errorJson(
          'nft_already_minted',
          'NFT has already been minted for this credential.',
          409,
        );
      }
    }
    getRootLogger().error(
      {
        event: 'nft_mint_chain_failed',
        customerId: customer.id,
        credentialId: credential.id,
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'NFT mint failed at chain boundary',
    );
    return ctx.errorJson(
      'nft_mint_failed',
      'Could not mint NFT on chain. Please try again.',
      502,
    );
  }

  // --- 8. Atomic CAS update outside the lock tx. The advisory lock already
  //         serialised concurrent submitters; this CAS is the final atomic
  //         write. `nft_contract_id` stores the ERC-721 token id;
  //         `nft_chain_update_id` stores the mint tx hash (Etherscan link).
  const claimed = await claimCredentialNftMinted(
    db,
    credential.id,
    nftResult.tokenId.toString(),
    now,
    nftResult.txHash,
  );
  if (!claimed) {
    getRootLogger().error(
      {
        event: 'nft_mint_cas_lost_unexpected',
        customerId: customer.id,
        credentialId: credential.id,
        orphanTokenId: nftResult.tokenId.toString(),
        txHash: nftResult.txHash,
      },
      'NFT mint CAS lost despite advisory lock — investigate (lock leak or race)',
    );
    return ctx.errorJson(
      'nft_already_minted',
      'NFT was minted concurrently. Please refresh.',
      409,
    );
  }

  // --- 8. Audit. `nft_minted` action mirrors the prior worker-side
  //         audit; the actor is the customer now (user-triggered)
  //         rather than `system:credential-pipeline`.
  const auditCtx = buildAuditRequestContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
  await writeAudit(db, {
    action: 'customer.nft_minted',
    actor: customerActor({ id: customer.id, label: customerLabel(customer) }),
    target: uuidTarget({
      kind: 'credential',
      id: credential.id,
      ref: nftResult.tokenId.toString(),
    }),
    context: auditCtx,
    meta: {
      customerId: customer.id,
      credentialId: credential.id,
      credentialRef: credential.chainContractId,
      nftTokenId: nftResult.tokenId.toString(),
      txHash: nftResult.txHash,
      serialNumber: serial,
      theme: body.theme,
    },
    ts: now,
  });

  return ctx.json(
    {
      nftContractId: nftResult.tokenId.toString(),
      serialNumber: serial,
      mintedAt: now.toISOString(),
      theme: body.theme,
    },
    201,
  );
}
