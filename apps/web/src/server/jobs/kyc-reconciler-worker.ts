/**
 * KYC reconciler worker — periodic drift sweep for the Didit pipeline.
 *
 * The Crivacy KYC pipeline has two paths that drive a credential
 * mint after Didit approves a verification:
 *
 *   1. Webhook path — Didit POST hits `/api/webhooks/didit`, the
 *      handler enqueues `credential-pipeline`.
 *   2. Pull-fallback — `/kyc` SSE poll loop calls `getDecision` while
 *      the customer's tab is open and enqueues the same pipeline.
 *
 * Both require either a successful HTTP delivery OR an open browser
 * tab. A 401 webhook (signature mismatch) plus a closed tab leaves the
 * customer permanently stranded: Didit shows Approved, Crivacy shows
 * `kyc_started` with no credential row, and no on-chain mint ever
 * happens. The 2026-05-07 incident is the canonical example.
 *
 * This worker closes the gap. Every 15 minutes it scans the audit log
 * for `customer.kyc_started` events with no completion event + no
 * active credential, fetches the live Didit decision, and re-routes
 * through the same `enqueueCredentialPipeline` path the webhook would
 * have taken. The pipeline's existing 5 layers of double-mint
 * protection (pg-boss singleton, Phase 1 pre-check, Phase 2 replay
 * guard, partial unique index, chain commandId) absorb any race with
 * a late-arriving webhook.
 *
 * Principles + edge cases: see `.claude/KYC-RECONCILER-WORKER.md`.
 *
 * @module
 */

import type PgBoss from 'pg-boss';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { uuidTarget } from '@/lib/audit/targets';
import { EMPTY_CONTEXT } from '@/lib/audit/context';
import { revokeActiveKycSessions } from '@/lib/customer/kyc-reset';
import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import { getDiditConfig } from '@crivacy-fhe/adapter-didit/config';
import { isDiditErrorWithCode } from '@crivacy-fhe/adapter-didit/errors';
import { getDecision } from '@crivacy-fhe/adapter-didit/session';
import {
  mapDiditStatusToInternal,
  PULL_OVERWRITABLE_STATUSES,
  RECONCILER_PENDING_INTERNAL_STATUSES,
} from '@crivacy-fhe/adapter-didit/status-mapping';
import { asDiditSessionIdUnchecked } from '@crivacy-fhe/adapter-didit/types';
import {
  CREDENTIAL_PIPELINE_QUEUE,
  enqueueCredentialPipeline,
} from './credential-pipeline-worker';
import {
  applyFaceMatchSideEffects,
  evaluateFaceMatchFromDecision,
  incrementDecline,
} from '@/lib/fraud';

/* ---------- Constants ---------- */

/** pg-boss queue name for the reconciler. */
export const KYC_RECONCILER_QUEUE = 'kyc-reconciler';

/** Default cron — every 15 minutes. */
const DEFAULT_CRON = '*/15 * * * *';

/** Default lookback window — 7 days. */
const DEFAULT_LOOKBACK_HOURS = 168;

/** Default per-cycle ceiling on drift candidates. */
const DEFAULT_MAX_PER_CYCLE = 100;

/** Default min interval between Didit GETs in ms (2 RPS). */
const DEFAULT_THROTTLE_MS = 500;

/** Random jitter added per call (0..N ms) to avoid lockstep across replicas. */
const THROTTLE_JITTER_MS = 100;

/** Streak ceiling for the 401 alert (Didit API key likely rotated). */
const API_KEY_FAILURE_STREAK_ALERT_THRESHOLD = 5;

/**
 * Sprint 9 Faz 1.5 — stuck-mint detection threshold (ms).
 *
 * `kyc_credentials_meta.status='pending'` should clear within minutes
 * of the row being inserted (chain mint succeeds → status flips to
 * `active`). pg-boss retries the credential pipeline up to 5 times
 * with exponential backoff (max ~15 min) and dead-letters at 2 hours
 * via `expireInSeconds`. A row stuck at `pending` past 30 minutes is
 * therefore outside both windows: either the job dead-lettered, the
 * worker process crashed mid-mint, or the queue lost the job during
 * a deploy. Re-enqueuing is safe — the pipeline's idempotency
 * layers (singleton key, Phase 1 pre-check on contract id, partial
 * unique index, chain commandId) absorb any race with a late-
 * arriving original.
 */
const STUCK_MINT_THRESHOLD_MS = 30 * 60_000;

/**
 * NFT-mint orphan threshold — how long a credential row may sit with
 * `level='enhanced'`, `chainContractId NOT NULL`, `nftContractId IS NULL`
 * before the reconciler tries to recover it. The user-triggered NFT
 * mint endpoint runs in seconds; a row that stays NFT-less past 15
 * minutes after the *credential* mint indicates either the customer
 * never clicked Mint (no recovery needed — leave alone) or the mint
 * endpoint crashed mid-handler after chain accepted the submit
 * (deterministic command id guarantees the chain has the NFT; only
 * the DB cross-reference is missing).
 *
 * The reconciler distinguishes these two cases by an explicit guard
 * on `confirmedAt` / `updatedAt` — see `findOrphanNftCandidates`.
 */
const ORPHAN_NFT_THRESHOLD_MS = 15 * 60_000;

/* ---------- Types ---------- */

export interface KycReconcilerWorkerDeps {
  readonly db: CrivacyDatabase;
  readonly logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Test seam — overrides `Date.now()` reads inside the throttle. */
  readonly clock?: () => number;
  /** Test seam — overrides the inter-call sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface KycReconcilerConfig {
  readonly lookbackHours: number;
  readonly maxPerCycle: number;
  readonly throttleMs: number;
  readonly cron: string;
  readonly disabled: boolean;
}

/** Drift row shape returned by `findDriftCandidates`. */
interface DriftCandidate {
  readonly customerId: string;
  readonly startedAt: Date;
}

/* ---------- Configuration ---------- */

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Resolve the runtime config from env. Exported for the ops script
 * (`scripts/kyc-reconcile-once.ts`) so manual runs honour the same
 * knobs the cron worker reads.
 */
export function loadKycReconcilerConfig(): KycReconcilerConfig {
  return Object.freeze({
    lookbackHours: readPositiveInt('KYC_RECONCILER_LOOKBACK_HOURS', DEFAULT_LOOKBACK_HOURS),
    maxPerCycle: readPositiveInt('KYC_RECONCILER_MAX_PER_CYCLE', DEFAULT_MAX_PER_CYCLE),
    throttleMs: readPositiveInt('KYC_RECONCILER_THROTTLE_MS', DEFAULT_THROTTLE_MS),
    cron: process.env['KYC_RECONCILER_CRON'] ?? DEFAULT_CRON,
    disabled: readBool('KYC_RECONCILER_DISABLE', false),
  });
}

/* ---------- 401 streak alert ---------- */

/**
 * Counts consecutive Didit 401s. Reset on any non-401 outcome.
 * Surfaces an error-level log line once the streak crosses the
 * threshold so the SOC dashboard catches the rotated-API-key case.
 *
 * Structural interface (not a class) so the manual ops script and
 * tests can substitute a no-op or counting double without
 * inheritance. The cron path uses `createFailureStreakCounter` to
 * build the production implementation.
 */
export interface FailureStreakCounter {
  increment(): void;
  reset(): void;
  /** Test introspection only. Production code never reads this. */
  current(): number;
}

export function createFailureStreakCounter(
  logger: KycReconcilerWorkerDeps['logger'],
  threshold: number,
): FailureStreakCounter {
  let streak = 0;
  return {
    increment(): void {
      streak += 1;
      if (streak === threshold) {
        logger?.error(
          '[kyc-reconciler] DIDIT API key may be expired/rotated — consecutive 401s threshold hit',
          { streak, threshold },
        );
      } else if (streak > threshold && streak % threshold === 0) {
        // Re-emit every `threshold` continued failures so the alarm
        // does not go silent after the first emission.
        logger?.error('[kyc-reconciler] DIDIT API still 401 — streak continues', {
          streak,
        });
      }
    },
    reset(): void {
      streak = 0;
    },
    current(): number {
      return streak;
    },
  };
}

/**
 * No-op streak counter for callers that want to invoke
 * `reconcileCustomer` outside the cron loop (manual ops scripts,
 * tests). Increment / reset are silent; current always reads 0.
 */
export function createNoopFailureStreakCounter(): FailureStreakCounter {
  return {
    increment: (): void => undefined,
    reset: (): void => undefined,
    current: (): number => 0,
  };
}

/* ---------- Throttle ---------- */

/**
 * Build a throttle that enforces a minimum interval between calls
 * with optional jitter. The clock + sleep are injected for tests so
 * vitest's fake timers can drive deterministic assertions without
 * real wall-clock waits.
 */
export function buildThrottle(
  intervalMs: number,
  deps: { readonly clock?: () => number; readonly sleep?: (ms: number) => Promise<void> } = {},
): () => Promise<void> {
  const clock = deps.clock ?? ((): number => Date.now());
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  // `null` sentinel for first-call detection — using `0` would
  // misclassify when the test clock starts at 0 (sleep would never
  // fire on the second call because `lastAt > 0` stayed false).
  let lastAt: number | null = null;
  return async function throttle(): Promise<void> {
    const now = clock();
    if (lastAt !== null) {
      const since = now - lastAt;
      if (since < intervalMs) {
        const jitter = Math.floor(Math.random() * THROTTLE_JITTER_MS);
        await sleep(intervalMs - since + jitter);
      }
    }
    lastAt = clock();
  };
}

/* ---------- Drift query ---------- */

/**
 * Find customers in drift state: a `customer.kyc_started` audit row
 * exists in the lookback window, no completion / reset / Didit-revoke
 * audit row exists for the same customer in the same window, AND the
 * customer has no active or pending credential row at all.
 *
 * Filters:
 *   - `customers.revokedAt IS NULL` — admin override skip (P7).
 *   - `customers.deletedAt IS NULL` — soft-deleted skip.
 *
 * Ordered newest first so a sweep that hits the per-cycle ceiling
 * processes the freshest drifts before older tail rows.
 *
 * Exported for `scripts/kyc-reconcile-once.ts` (ops escape hatch
 * runs this query with `lookbackHours = MAX_INT` so very old drifts
 * can be reconciled manually without poisoning the cron schedule).
 */
export async function findDriftCandidates(
  db: CrivacyDatabase,
  options: { readonly lookbackHours: number; readonly maxPerCycle: number },
): Promise<readonly DriftCandidate[]> {
  const lookbackInterval = sql.raw(`'${options.lookbackHours} hours'`);
  // Drizzle's typed builder cannot model the audit_log filter cleanly
  // (the `targetId` column is text but our customer.id is uuid; the
  // matching audit-writer always writes the canonical uuid string).
  // Use raw SQL for the started + completed CTEs and join the
  // builder result against `customers` + `kyc_credentials_meta` for
  // the structured filters.
  const rows = await db.execute<{ customer_id: string; started_at: string }>(sql`
    WITH started AS (
      SELECT a.target_id::uuid AS customer_id, MAX(a.ts) AS started_at
        FROM audit_log a
       WHERE a.action = 'customer.kyc_started'
         AND a.target_kind = 'customer'
         AND a.target_id IS NOT NULL
         AND a.ts > now() - INTERVAL ${lookbackInterval}
       GROUP BY a.target_id
    ),
    completed AS (
      SELECT DISTINCT a.target_id::uuid AS customer_id
        FROM audit_log a
       WHERE a.action IN (
               'customer.kyc_completed',
               'customer.kyc_reset',
               'customer.kyc_revoked_by_didit_user'
             )
         AND a.target_kind = 'customer'
         AND a.target_id IS NOT NULL
         AND a.ts > now() - INTERVAL ${lookbackInterval}
    ),
    active_creds AS (
      SELECT DISTINCT m.user_ref AS user_ref
        FROM kyc_credentials_meta m
       WHERE m.status IN ('pending','active')
         AND m.validator = 'didit'
    )
    SELECT s.customer_id::text AS customer_id, s.started_at::text AS started_at
      FROM started s
      JOIN customers cu ON cu.id = s.customer_id
      LEFT JOIN completed c ON c.customer_id = s.customer_id
      LEFT JOIN active_creds ac ON ac.user_ref = s.customer_id::text
     WHERE c.customer_id IS NULL
       AND ac.user_ref IS NULL
       AND cu.revoked_at IS NULL
       AND cu.deleted_at IS NULL
     ORDER BY s.started_at DESC
     LIMIT ${options.maxPerCycle};
  `);

  return Object.freeze(
    rows.rows.map((r) =>
      Object.freeze({
        customerId: r.customer_id,
        startedAt: new Date(r.started_at),
      }),
    ),
  );
}

/**
 * Find the latest KYC session row for a customer. Used by the
 * reconciler to pick which Didit session to re-fetch + replay.
 * Returns the newest session regardless of status — the route logic
 * branches on the live Didit decision, not on the stored status.
 *
 * Sprint 7 Phase E — reads the unified `kyc_sessions` table with a
 * `kind = 'customer'` filter. The B2B reconciler is not part of
 * Sprint 7 scope; if it ever lands, it would reuse this same table
 * with `kind = 'b2b'` and pivot on (firm_id, user_ref) instead.
 */
async function findLatestKycSession(
  db: CrivacyDatabase,
  customerId: string,
): Promise<typeof schema.kycSessions.$inferSelect | null> {
  const rows = await db
    .select()
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.kind, 'customer' as const),
        eq(schema.kycSessions.customerId, customerId),
      ),
    )
    .orderBy(desc(schema.kycSessions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Phase 2 prerequisite: a Phase 2 (address) reconciliation requires
 * an active Phase 1 credential for the customer. If the Phase 1
 * credential is missing (was never minted, was revoked, was reset)
 * the reconciler skips and audits — the pipeline cannot mint an
 * Enhanced credential without the Basic prerequisite.
 */
async function findActivePhase1Credential(
  db: CrivacyDatabase,
  customerId: string,
): Promise<typeof schema.kycCredentialsMeta.$inferSelect | null> {
  const rows = await db
    .select()
    .from(schema.kycCredentialsMeta)
    .where(
      and(
        eq(schema.kycCredentialsMeta.userRef, customerId),
        eq(schema.kycCredentialsMeta.status, 'active'),
        eq(schema.kycCredentialsMeta.level, 'basic'),
        eq(schema.kycCredentialsMeta.validator, 'didit'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/* ---------- Reverse-drift query ---------- */

/**
 * Reverse drift candidate row. The reverse-drift pass complements the
 * forward-drift pass (above): forward = "Didit Approved but Crivacy
 * never minted"; reverse = "Crivacy reset / revoked the customer but
 * one or more `kyc_sessions` rows were left in a revokable state by
 * an incomplete mutation path".
 */
interface ReverseDriftCandidate {
  readonly customerId: string;
  readonly kycLevel: string;
  readonly orphanSessionCount: number;
}

/**
 * Find customers whose row state proves a reset / revoke happened
 * but whose `kyc_sessions` table still carries one or more revokable
 * (non-terminal) rows. The trigger MUST be a definitive reset signal,
 * not just "kyc_level = kyc_0", because a brand-new customer in
 * mid-flow has both `kyc_level = kyc_0` AND an active session — that
 * is the normal "Start KYC just clicked" state, not drift. Acting on
 * it would kill the in-flight session.
 *
 * Two definitive signals (either is sufficient):
 *
 *   1. `customers.revoked_at IS NOT NULL` — Didit user-entity revoke
 *      stamped the column. The session sweep should have followed
 *      (`handleUserEntityWebhook` calls `revokeActiveKycSessions`),
 *      so an active session here means the sweep failed mid-flight
 *      (network blip, deploy window).
 *
 *   2. The customer has at least one row in `kyc_credentials_meta`
 *      with a terminal status (`revoked`, `superseded`, `expired`).
 *      That row only appears AFTER a credential mint, which only
 *      happens AFTER an Approved Didit decision — so its existence
 *      proves the customer once had a verified state. A subsequent
 *      reset (admin `reset_kyc`, Didit `Kyc Expired`, or face-match
 *      cascade) flipped the credential to terminal but should also
 *      have closed the session.
 *
 * The "active" status set is duplicated as a Postgres array literal
 * here because Drizzle's typed builder can't model a `WHERE status =
 * ANY(...)` against the enum cleanly inside an EXISTS subquery. The
 * literal must stay in sync with {@link REVOKABLE_SESSION_STATUSES};
 * the integration test pins both lists so a future addition fails
 * loudly here rather than silently widening detection.
 *
 * `customers.deleted_at IS NULL` filters soft-deleted rows (their
 * sessions are FK-cascaded on hard delete; soft-delete keeps them
 * but the customer is no longer reachable, so reconciliation has no
 * surface to act on).
 *
 * Ordered by orphan count descending so the worst drifts are addressed
 * first when the per-cycle ceiling is hit.
 */
export async function findReverseDriftCandidates(
  db: CrivacyDatabase,
  options: { readonly maxPerCycle: number },
): Promise<readonly ReverseDriftCandidate[]> {
  const rows = await db.execute<{
    customer_id: string;
    kyc_level: string;
    orphan_session_count: string;
  }>(sql`
    SELECT cu.id::text AS customer_id,
           cu.kyc_level::text AS kyc_level,
           COUNT(s.id)::text AS orphan_session_count
      FROM customers cu
      JOIN kyc_sessions s
        ON s.customer_id = cu.id
       AND s.kind = 'customer'
       AND s.status IN (
         'pending', 'in_progress', 'in_review',
         'identity_approved', 'address_in_progress',
         'approved', 'resubmission_pending'
       )
     WHERE cu.deleted_at IS NULL
       AND (
         cu.revoked_at IS NOT NULL
         OR (
           EXISTS (
             SELECT 1
               FROM kyc_credentials_meta kc_old
              WHERE kc_old.user_ref = cu.id::text
                AND kc_old.status IN ('revoked', 'superseded', 'expired')
           )
           -- Sprint 8 follow-up: only fire reverse-drift when the
           -- customer has NO currently-active credential. Without
           -- this guard, a customer with mixed history (one old
           -- revoked credential AND a fresh active one — e.g.
           -- after admin reset_kyc + re-KYC) would be wrongly
           -- flagged and the reconciler would close their fresh
           -- pending/in-progress address session every 15 min.
           -- The historical revoked row is not a "definitive reset
           -- signal" if a newer active row exists alongside it.
           AND NOT EXISTS (
             SELECT 1
               FROM kyc_credentials_meta kc_active
              WHERE kc_active.user_ref = cu.id::text
                AND kc_active.status IN ('active', 'pending')
           )
           -- 2026-05-10 fix: also skip when an active session was
           -- created AFTER the latest credential revocation. The
           -- pre-fix guard caught "old revoke + new active cred"
           -- (admin reset_kyc then re-KYC succeeded), but missed
           -- "old revoke + new active session, no cred yet"
           -- (admin reset_kyc, user clicked Start KYC, currently
           -- mid-Didit-flow, NO kyc_credentials_meta row exists
           -- yet because credential is only inserted post-Didit-
           -- approve). Without this clause the reconciler closes
           -- the users fresh re-KYC session ~15 min after they
           -- start it, leaving the page stranded.
           --
           -- Concretely: if the customers most recent credential
           -- revoke happened BEFORE any active session started, the
           -- session is the new flow and must be left alone.
           AND NOT EXISTS (
             SELECT 1
               FROM kyc_sessions s_fresh
               JOIN kyc_credentials_meta kc_revoked
                 ON kc_revoked.user_ref = cu.id::text
                AND kc_revoked.revoked_at IS NOT NULL
              WHERE s_fresh.customer_id = cu.id
                AND s_fresh.kind = 'customer'
                AND s_fresh.status IN (
                  'pending', 'in_progress', 'in_review',
                  'identity_approved', 'address_in_progress',
                  'approved', 'resubmission_pending'
                )
                AND s_fresh.started_at > kc_revoked.revoked_at
           )
         )
       )
     GROUP BY cu.id, cu.kyc_level
     ORDER BY COUNT(s.id) DESC, cu.id ASC
     LIMIT ${options.maxPerCycle};
  `);

  return Object.freeze(
    rows.rows.map((r) =>
      Object.freeze({
        customerId: r.customer_id,
        kycLevel: r.kyc_level,
        orphanSessionCount: Number.parseInt(r.orphan_session_count, 10),
      }),
    ),
  );
}

/* ---------- Stuck-mint detection (Sprint 9 Faz 1.5) ---------- */

/**
 * Drift case 3: the credential pipeline was enqueued (an inserted
 * `kyc_credentials_meta` row exists) but its `status` is still
 * `pending` past {@link STUCK_MINT_THRESHOLD_MS}. The pipeline's
 * pg-boss retries should have cleared this within ~15 minutes; a
 * row sitting at `pending` for half an hour means either pg-boss
 * dead-lettered the job, the worker crashed mid-mint, or a deploy
 * lost the job. Either way the row needs a manual nudge — the
 * reconciler re-enqueues the pipeline via the canonical
 * `enqueueCredentialPipeline` so the same idempotency layers apply.
 *
 * Returns one row per stuck candidate, joined to `kyc_sessions` so
 * the caller has the Didit session id, kind, customer id, and
 * workflow it needs to rebuild the job payload. Rows whose
 * `kyc_session_id` was set to NULL (session was deleted via FK
 * cascade) are excluded — without the Didit session id we cannot
 * rebuild the pipeline job, and an orphan meta row would need
 * manual ops cleanup anyway.
 */
export interface StuckMintCandidate {
  readonly metaId: string;
  readonly firmId: string;
  readonly userRef: string;
  readonly kycSessionId: string;
  readonly diditSessionId: string;
  readonly sessionKind: 'customer' | 'b2b';
  readonly customerId: string | null;
  readonly workflow: 'identity' | 'address';
  readonly metaCreatedAt: Date;
}

export async function findStuckMintCandidates(
  db: CrivacyDatabase,
  options: { readonly thresholdMs: number; readonly maxPerCycle: number },
): Promise<readonly StuckMintCandidate[]> {
  const thresholdSeconds = Math.floor(options.thresholdMs / 1000);
  const rows = await db.execute<{
    meta_id: string;
    firm_id: string;
    user_ref: string;
    kyc_session_id: string;
    didit_session_id: string;
    session_kind: 'customer' | 'b2b';
    customer_id: string | null;
    workflow: string;
    meta_created_at: string;
  }>(sql`
    SELECT m.id::text       AS meta_id,
           m.firm_id::text  AS firm_id,
           m.user_ref       AS user_ref,
           s.id::text       AS kyc_session_id,
           s.didit_session_id AS didit_session_id,
           s.kind::text     AS session_kind,
           s.customer_id::text AS customer_id,
           s.workflow::text AS workflow,
           m.created_at     AS meta_created_at
      FROM kyc_credentials_meta m
      JOIN kyc_sessions s
        ON s.id = m.kyc_session_id
     WHERE m.status = 'pending'
       AND m.kyc_session_id IS NOT NULL
       AND s.didit_session_id IS NOT NULL
       AND s.workflow IN ('identity', 'address')
       AND m.created_at < NOW() - (${thresholdSeconds}::int * INTERVAL '1 second')
     ORDER BY m.created_at ASC
     LIMIT ${options.maxPerCycle};
  `);

  return Object.freeze(
    rows.rows.map((r) =>
      Object.freeze({
        metaId: r.meta_id,
        firmId: r.firm_id,
        userRef: r.user_ref,
        kycSessionId: r.kyc_session_id,
        diditSessionId: r.didit_session_id,
        sessionKind: r.session_kind,
        customerId: r.customer_id,
        workflow: r.workflow as 'identity' | 'address',
        metaCreatedAt: new Date(r.meta_created_at),
      }),
    ),
  );
}

/* ---------- Per-credential stuck-mint reconciliation ---------- */

export type StuckMintOutcome =
  | {
      readonly kind: 'stuck_mint_resolved';
      readonly metaId: string;
      readonly kycSessionId: string;
      readonly bossJobId: string | null;
    }
  | {
      readonly kind: 'stuck_mint_skipped';
      readonly metaId: string;
      readonly reason: 'invalid_session_kind' | 'invalid_workflow' | 'enqueue_returned_null';
    };

/**
 * Reconcile one stuck-mint candidate by rebuilding the credential
 * pipeline job payload off the joined `kyc_sessions` row and re-
 * enqueuing it. The `enqueueCredentialPipeline` helper carries the
 * `singletonKey` dedup so a still-in-flight original job is left
 * alone; only dead-lettered or lost jobs actually re-run.
 */
export async function reconcileStuckMint(
  deps: { readonly db: CrivacyDatabase; readonly boss: PgBoss; readonly now: Date },
  candidate: StuckMintCandidate,
): Promise<StuckMintOutcome> {
  const { db, boss, now } = deps;

  // Rebuild the typed pipeline payload. Sprint 5 split this into two
  // unions (customer + b2b) — the `flow` discriminator routes the
  // worker into the correct branch. Defensive guards reject any
  // shape that wouldn't satisfy the worker's expectations even
  // though the SQL filter above narrows kind + workflow.
  if (candidate.sessionKind === 'customer') {
    if (candidate.customerId === null) {
      await writeReconcilerAudit(
        db,
        'kyc_reconciler.stuck_mint_detected',
        candidate.metaId,
        {
          reason: 'customer_session_missing_customer_id',
          metaId: candidate.metaId,
          kycSessionId: candidate.kycSessionId,
        },
        now,
      );
      return {
        kind: 'stuck_mint_skipped',
        metaId: candidate.metaId,
        reason: 'invalid_session_kind',
      };
    }
    const jobId = await enqueueCredentialPipeline(boss, {
      flow: 'customer',
      kycSessionId: candidate.kycSessionId,
      customerId: candidate.customerId,
      diditSessionId: candidate.diditSessionId,
      phase: candidate.workflow,
    });
    if (jobId === null) {
      // Singleton dedup hit — the original job is still in flight,
      // not actually stuck. Audit + skip so the SOC sees the
      // signal without the count of "resolved" entries inflating.
      await writeReconcilerAudit(
        db,
        'kyc_reconciler.stuck_mint_detected',
        candidate.metaId,
        {
          reason: 'singleton_dedup_active',
          metaId: candidate.metaId,
          kycSessionId: candidate.kycSessionId,
          phase: candidate.workflow,
        },
        now,
      );
      return {
        kind: 'stuck_mint_skipped',
        metaId: candidate.metaId,
        reason: 'enqueue_returned_null',
      };
    }
    await writeReconcilerAudit(
      db,
      'kyc_reconciler.stuck_mint_resolved',
      candidate.metaId,
      {
        metaId: candidate.metaId,
        kycSessionId: candidate.kycSessionId,
        phase: candidate.workflow,
        bossJobId: jobId,
        flow: 'customer',
        ageMs: now.getTime() - candidate.metaCreatedAt.getTime(),
      },
      now,
    );
    return {
      kind: 'stuck_mint_resolved',
      metaId: candidate.metaId,
      kycSessionId: candidate.kycSessionId,
      bossJobId: jobId,
    };
  }

  // B2B branch — enqueue with the firm + userRef the row carries.
  const jobId = await enqueueCredentialPipeline(boss, {
    flow: 'b2b',
    kycSessionId: candidate.kycSessionId,
    firmId: candidate.firmId,
    userRef: candidate.userRef,
    diditSessionId: candidate.diditSessionId,
    phase: candidate.workflow,
  });
  if (jobId === null) {
    await writeReconcilerAudit(
      db,
      'kyc_reconciler.stuck_mint_detected',
      candidate.metaId,
      {
        reason: 'singleton_dedup_active',
        metaId: candidate.metaId,
        kycSessionId: candidate.kycSessionId,
        phase: candidate.workflow,
        flow: 'b2b',
      },
      now,
    );
    return {
      kind: 'stuck_mint_skipped',
      metaId: candidate.metaId,
      reason: 'enqueue_returned_null',
    };
  }
  await writeReconcilerAudit(
    db,
    'kyc_reconciler.stuck_mint_resolved',
    candidate.metaId,
    {
      metaId: candidate.metaId,
      kycSessionId: candidate.kycSessionId,
      phase: candidate.workflow,
      bossJobId: jobId,
      flow: 'b2b',
      ageMs: now.getTime() - candidate.metaCreatedAt.getTime(),
    },
    now,
  );
  return {
    kind: 'stuck_mint_resolved',
    metaId: candidate.metaId,
    kycSessionId: candidate.kycSessionId,
    bossJobId: jobId,
  };
}

/* ---------- Stuck-NFT-mint detection ---------- */

/**
 * Drift case 4: a credential row is `active` with `level='enhanced'`,
 * the credential mint landed on chain (`chain_contract_id NOT NULL`),
 * but the NFT cross-reference (`nft_contract_id`) is still NULL past
 * the {@link ORPHAN_NFT_THRESHOLD_MS} window AND the row was modified
 * within that window — i.e. the customer recently triggered the mint
 * endpoint, chain accepted the submit (deterministic command id
 * guarantees no on-chain duplicate), but the post-chain DB UPDATE
 * never landed (handler crash / connection drop).
 *
 * The `updated_at < threshold` guard keeps the pass from sweeping
 * customers who simply never clicked Mint — those rows have
 * `updated_at` matching `confirmed_at` and would never be touched
 * again until the customer comes back to the page.
 */
export interface OrphanNftCandidate {
  readonly metaId: string;
  readonly chainContractId: string;
  /** The subject's EVM address — the on-chain key for the soulbound NFT. */
  readonly userParty: string;
  readonly userRef: string;
  readonly metaUpdatedAt: Date;
}

export async function findOrphanNftCandidates(
  db: CrivacyDatabase,
  options: { readonly thresholdMs: number; readonly maxPerCycle: number },
): Promise<readonly OrphanNftCandidate[]> {
  const thresholdSeconds = Math.floor(options.thresholdMs / 1000);
  // Heuristic: only sweep rows that were `updated_at` more than the
  // threshold ago AND less than 24h ago. The lower bound catches
  // rows the customer never actually tried to mint (no recent UPDATE
  // beyond the credential confirmation). The upper bound caps the
  // backlog the reconciler will rehydrate per pass — anything older
  // than 24h is an ops-investigation case, not autonomous recovery.
  const rows = await db.execute<{
    meta_id: string;
    chain_contract_id: string;
    user_party: string;
    user_ref: string;
    meta_updated_at: string;
  }>(sql`
    SELECT m.id::text          AS meta_id,
           m.chain_contract_id AS chain_contract_id,
           m.user_party        AS user_party,
           m.user_ref          AS user_ref,
           m.updated_at        AS meta_updated_at
      FROM kyc_credentials_meta m
     WHERE m.status = 'active'
       AND m.level = 'enhanced'
       AND m.chain_contract_id IS NOT NULL
       AND m.nft_contract_id IS NULL
       AND m.updated_at < NOW() - (${thresholdSeconds}::int * INTERVAL '1 second')
       AND m.updated_at > NOW() - INTERVAL '24 hours'
       AND m.confirmed_at IS NOT NULL
       AND m.confirmed_at < m.updated_at
     ORDER BY m.updated_at ASC
     LIMIT ${options.maxPerCycle};
  `);

  return Object.freeze(
    rows.rows.map((r) =>
      Object.freeze({
        metaId: r.meta_id,
        chainContractId: r.chain_contract_id,
        userParty: r.user_party,
        userRef: r.user_ref,
        metaUpdatedAt: new Date(r.meta_updated_at),
      }),
    ),
  );
}

export type OrphanNftOutcome =
  | {
      readonly kind: 'orphan_nft_resolved';
      readonly metaId: string;
      readonly nftContractId: string;
    }
  | {
      readonly kind: 'orphan_nft_skipped';
      readonly metaId: string;
      readonly reason:
        | 'chain_lookup_failed'
        | 'no_nft_on_chain'
        | 'cas_lost';
    };

/**
 * Recover one orphan NFT row by querying chain's active KycNFT set
 * for a contract whose `boundCredentialId` matches the credential's
 * `chain_contract_id`. If found, write the NFT contract id and
 * `nftMintedAt` back via the same atomic CAS used by the user-
 * triggered mint endpoint — a concurrent winner (e.g. the customer
 * tried again and won the race) is left alone.
 */
export async function reconcileOrphanNft(
  deps: {
    readonly db: CrivacyDatabase;
    readonly fhe: import('@crivacy-fhe/credential').FheClient;
    readonly now: Date;
  },
  candidate: OrphanNftCandidate,
): Promise<OrphanNftOutcome> {
  const { db, fhe, now } = deps;
  const { claimCredentialNftMinted } = await import('@/server/repositories/credentials');

  // The soulbound NFT is keyed on the subject's EVM address (one token per
  // customer). Query the chain: a non-zero token id means the mint landed but
  // the DB row never recorded it.
  let nftContractId: string | null;
  try {
    const tokenId = await fhe.tokenOfCustomer(candidate.userParty as `0x${string}`);
    nftContractId = tokenId === 0n ? null : tokenId.toString();
  } catch (err) {
    await writeReconcilerAudit(
      db,
      'kyc_reconciler.stuck_nft_mint_detected',
      candidate.metaId,
      {
        reason: 'chain_lookup_failed',
        metaId: candidate.metaId,
        userRef: candidate.userRef,
        err: err instanceof Error ? err.message : String(err),
      },
      now,
    );
    return {
      kind: 'orphan_nft_skipped',
      metaId: candidate.metaId,
      reason: 'chain_lookup_failed',
    };
  }
  if (nftContractId === null) {
    await writeReconcilerAudit(
      db,
      'kyc_reconciler.stuck_nft_mint_detected',
      candidate.metaId,
      {
        reason: 'no_nft_on_chain',
        metaId: candidate.metaId,
        userRef: candidate.userRef,
      },
      now,
    );
    return {
      kind: 'orphan_nft_skipped',
      metaId: candidate.metaId,
      reason: 'no_nft_on_chain',
    };
  }

  // Active-contracts API does not surface the originating tx's
  // updateId. We persist `nftChainUpdateId = null` here; ccview deep
  // links for these recovered rows will render inert (the
  // `ChainTxLink` already handles null gracefully). An admin can
  // backfill the update id via the existing one-off script if a
  // clickable link is required for support / audit.
  const claimed = await claimCredentialNftMinted(
    db,
    candidate.metaId,
    nftContractId,
    now,
    null,
  );
  if (!claimed) {
    return {
      kind: 'orphan_nft_skipped',
      metaId: candidate.metaId,
      reason: 'cas_lost',
    };
  }

  await writeReconcilerAudit(
    db,
    'kyc_reconciler.stuck_nft_mint_resolved',
    candidate.metaId,
    {
      metaId: candidate.metaId,
      userRef: candidate.userRef,
      nftContractId,
      ageMs: now.getTime() - candidate.metaUpdatedAt.getTime(),
    },
    now,
  );
  return {
    kind: 'orphan_nft_resolved',
    metaId: candidate.metaId,
    nftContractId,
  };
}

/* ---------- Per-customer reverse-drift reconciliation ---------- */

/**
 * Outcome of a single reverse-drift reconciliation. Distinct shape from
 * {@link ReconcileOutcome} so the cycle counter can split forward vs
 * reverse passes when the SOC reads `kyc_reconciler.cycle_finished`.
 */
type ReverseDriftOutcome =
  | { readonly kind: 'reverse_drift_resolved'; readonly customerId: string; readonly revokedSessions: number }
  | { readonly kind: 'reverse_drift_noop'; readonly customerId: string };

/**
 * Reconcile a single customer's reverse drift. Calls the canonical
 * `revokeActiveKycSessions` helper — the same call admin reset_kyc,
 * ban, Didit user-entity revoke, and kyc_expired use. Idempotent: on
 * a second run the WHERE clause matches no rows because the previous
 * run flipped them to `revoked` (a terminal status outside
 * `REVOKABLE_SESSION_STATUSES`).
 */
export async function reconcileReverseDriftCustomer(
  deps: { readonly db: CrivacyDatabase; readonly now: Date },
  customerId: string,
): Promise<ReverseDriftOutcome> {
  const revoked = await revokeActiveKycSessions(
    deps.db,
    customerId,
    deps.now,
    'reverse_drift_reconciled',
  );

  if (revoked === 0) {
    // The candidate was raced by another writer (a concurrent
    // mutation path landed between the SELECT and the UPDATE). No
    // audit row — the SOC dashboard would otherwise fill with
    // false-positive entries. The next cycle re-checks anyway.
    return { kind: 'reverse_drift_noop', customerId };
  }

  await writeReconcilerAudit(
    deps.db,
    'kyc_reconciler.reverse_drift_resolved',
    customerId,
    {
      revokedSessions: revoked,
      reason: 'reverse_drift_reconciled',
    },
    deps.now,
  );
  return { kind: 'reverse_drift_resolved', customerId, revokedSessions: revoked };
}

/* ---------- Per-customer reconciliation ---------- */

/**
 * Branches that a single reconcileCustomer call may produce. The
 * worker writes the matching audit action for each — the union is
 * narrow on purpose so a future `default` branch in the audit code
 * can stay exhaustive.
 */
type ReconcileOutcome =
  | { readonly kind: 'enqueued_pipeline'; readonly sessionId: string; readonly phase: 'identity' | 'address' }
  | { readonly kind: 'session_status_synced'; readonly sessionId: string; readonly diditStatus: string; readonly newInternalStatus: string }
  | { readonly kind: 'didit_pending_decision'; readonly sessionId: string; readonly diditStatus: string }
  | { readonly kind: 'didit_unknown_status'; readonly sessionId: string; readonly diditStatus: string }
  | { readonly kind: 'didit_not_found'; readonly sessionId: string }
  | { readonly kind: 'didit_transient_error'; readonly sessionId: string | null; readonly errorCode: string; readonly errorMessage: string }
  | { readonly kind: 'no_session_found' }
  | { readonly kind: 'phase2_missing_phase1_prereq'; readonly sessionId: string }
  | { readonly kind: 'session_already_terminal'; readonly sessionId: string; readonly internalStatus: string };

interface ReconcileCustomerDeps {
  readonly db: CrivacyDatabase;
  readonly boss: PgBoss;
  readonly logger?: KycReconcilerWorkerDeps['logger'];
  readonly throttle: () => Promise<void>;
  readonly apiKeyFailureStreak: FailureStreakCounter;
  readonly now: Date;
}

/**
 * Reconcile a single customer in drift. Pure function w.r.t. its
 * deps — no global state read except `process.env` for the Didit
 * config (handled via `getDiditConfig()`'s memoised resolver).
 */
export async function reconcileCustomer(
  deps: ReconcileCustomerDeps,
  customerId: string,
): Promise<ReconcileOutcome> {
  const { db, boss, throttle, apiKeyFailureStreak, now } = deps;

  const session = await findLatestKycSession(db, customerId);
  if (session === null || session.diditSessionId === null) {
    await writeReconcilerAudit(db, 'kyc_reconciler.drift_detected', customerId, {
      outcome: 'no_session_found',
      sessionFound: session !== null,
      diditSessionIdPresent: session?.diditSessionId !== undefined && session?.diditSessionId !== null,
    }, now);
    return { kind: 'no_session_found' };
  }

  // If the latest session is already terminal in our DB AND nothing
  // is active on chain (reconciler only sees customers without
  // active credentials), this is a non-actionable drift — the user
  // never reached approval and there's nothing to mint. Audit the
  // visit so the SOC has a row but don't churn Didit GETs.
  if (
    session.status === 'rejected' ||
    session.status === 'expired' ||
    session.status === 'kyc_expired' ||
    session.status === 'revoked'
  ) {
    await writeReconcilerAudit(
      db,
      'kyc_reconciler.drift_detected',
      customerId,
      {
        outcome: 'session_already_terminal',
        sessionId: session.id,
        internalStatus: session.status,
      },
      now,
    );
    return { kind: 'session_already_terminal', sessionId: session.id, internalStatus: session.status };
  }

  // Phase 2 prerequisite (edge case 15).
  if (session.workflow === 'address') {
    const phase1 = await findActivePhase1Credential(db, customerId);
    if (phase1 === null) {
      await writeReconcilerAudit(
        db,
        'kyc_reconciler.phase_address_missing_identity_prereq',
        customerId,
        { sessionId: session.id, diditSessionId: session.diditSessionId },
        now,
      );
      return { kind: 'phase2_missing_phase1_prereq', sessionId: session.id };
    }
  }

  // Throttle ALWAYS before the Didit GET — applies even on the very
  // first call so a multi-replica burst-startup doesn't slam Didit.
  await throttle();

  let decision;
  try {
    const diditConfig = getDiditConfig();
    decision = await getDecision(diditConfig, asDiditSessionIdUnchecked(session.diditSessionId));
    apiKeyFailureStreak.reset();
  } catch (err) {
    const errorCode =
      err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
        ? err.code
        : 'unknown';
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (isDiditErrorWithCode(err, 'not_found')) {
      // Edge case 5: Didit user / session deleted. Mark session
      // expired (with status guard) so the customer's UI can route
      // to fresh-start instead of waiting forever. Mirrors the
      // pull-fallback's not_found branch.
      await db
        .update(schema.kycSessions)
        .set({
          status: 'expired',
          failureReason: 'reconciler_didit_not_found',
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.kycSessions.kind, 'customer' as const),
            eq(schema.kycSessions.id, session.id),
            inArray(schema.kycSessions.status, [...PULL_OVERWRITABLE_STATUSES]),
          ),
        );
      await writeReconcilerAudit(
        db,
        'kyc_reconciler.drift_detected',
        customerId,
        { outcome: 'didit_not_found', sessionId: session.id, diditSessionId: session.diditSessionId },
        now,
      );
      return { kind: 'didit_not_found', sessionId: session.id };
    }

    if (isDiditErrorWithCode(err, 'unauthorized')) {
      apiKeyFailureStreak.increment();
      await writeReconcilerAudit(
        db,
        'kyc_reconciler.drift_detected',
        customerId,
        {
          outcome: 'didit_transient_error',
          sessionId: session.id,
          errorCode,
          errorMessage,
        },
        now,
      );
      return {
        kind: 'didit_transient_error',
        sessionId: session.id,
        errorCode,
        errorMessage,
      };
    }

    // 429 / 5xx / network: log + audit, defer to next cycle.
    await writeReconcilerAudit(
      db,
      'kyc_reconciler.drift_detected',
      customerId,
      {
        outcome: 'didit_transient_error',
        sessionId: session.id,
        errorCode,
        errorMessage,
      },
      now,
    );
    return {
      kind: 'didit_transient_error',
      sessionId: session.id,
      errorCode,
      errorMessage,
    };
  }

  const internalStatus = mapDiditStatusToInternal(decision.status);

  if (internalStatus === null) {
    // Didit shipped a status we don't recognise. Audit + leave row
    // alone so the eventual mapping change advances it cleanly.
    await writeReconcilerAudit(
      db,
      'kyc_reconciler.drift_detected',
      customerId,
      {
        outcome: 'didit_unknown_status',
        sessionId: session.id,
        diditStatus: decision.status,
      },
      now,
    );
    return { kind: 'didit_unknown_status', sessionId: session.id, diditStatus: decision.status };
  }

  // Approved → enqueue pipeline. The pipeline's existing layered
  // dedupe (pg-boss singleton, Phase 1 pre-check, Phase 2 replay
  // guard, partial unique index, chain commandId) absorbs any
  // overlap with a webhook + pull arriving concurrently.
  if (internalStatus === 'approved') {
    // Sprint 6 — face-match cascade evaluation BEFORE enqueue. The
    // reconciler is the safety net for "push + pull both missed";
    // without this check, a banned-face Approved decision would
    // bypass the cascade entirely. Mirrors the webhook + pull
    // surfaces; the dispatch helper is the single source of cascade
    // semantics across all three.
    const faceMatchResult = await evaluateFaceMatchFromDecision(db, decision, {
      kind: 'customer',
      customerId,
    });
    if (faceMatchResult !== null && faceMatchResult.overrideReason !== null) {
      // Cascade fired. Sync the row to 'rejected' (with the cascade
      // reason as failure_reason) and apply side-effects. Skip the
      // pipeline enqueue — minting a credential for a banned face is
      // exactly what this gate prevents.
      await db
        .update(schema.kycSessions)
        .set({
          status: 'rejected',
          failureReason: faceMatchResult.overrideReason,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.kycSessions.kind, 'customer' as const),
            eq(schema.kycSessions.id, session.id),
            inArray(schema.kycSessions.status, [...PULL_OVERWRITABLE_STATUSES]),
          ),
        );
      await applyFaceMatchSideEffects(db, {
        evaluation: faceMatchResult.evaluation,
        context: { kind: 'customer', customerId },
        decision,
        currentDiditSessionId: decision.sessionId as unknown as string,
        customerKycSessionId: session.id,
        auditContext: EMPTY_CONTEXT,
        surface: 'reconciler_customer',
        now,
      });
      await writeReconcilerAudit(
        db,
        'kyc_reconciler.drift_resolved',
        customerId,
        {
          action: 'face_match_cascade',
          sessionId: session.id,
          diditSessionId: session.diditSessionId,
          overrideReason: faceMatchResult.overrideReason,
        },
        now,
      );
      return {
        kind: 'session_status_synced',
        sessionId: session.id,
        diditStatus: decision.status,
        newInternalStatus: 'rejected',
      };
    }

    const phase: 'identity' | 'address' = session.workflow === 'identity' ? 'identity' : 'address';
    await enqueueCredentialPipeline(boss, {
      kycSessionId: session.id,
      customerId,
      diditSessionId: session.diditSessionId,
      phase,
    });
    await writeReconcilerAudit(
      db,
      'kyc_reconciler.drift_resolved',
      customerId,
      {
        action: 'enqueued_pipeline',
        sessionId: session.id,
        diditSessionId: session.diditSessionId,
        phase,
      },
      now,
    );
    return { kind: 'enqueued_pipeline', sessionId: session.id, phase };
  }

  // Pending-style decisions — leave the row alone, retry next cycle.
  if ((RECONCILER_PENDING_INTERNAL_STATUSES as readonly string[]).includes(internalStatus)) {
    await writeReconcilerAudit(
      db,
      'kyc_reconciler.drift_detected',
      customerId,
      {
        outcome: 'didit_pending_decision',
        sessionId: session.id,
        diditStatus: decision.status,
        mappedInternal: internalStatus,
      },
      now,
    );
    return { kind: 'didit_pending_decision', sessionId: session.id, diditStatus: decision.status };
  }

  // Terminal non-approved — sync session row when still overwritable.
  // The status guard ensures a webhook that already moved the row to
  // a terminal state cannot be clobbered.
  const updated = await db
    .update(schema.kycSessions)
    .set({
      status: internalStatus as typeof schema.kycSessions.$inferInsert.status,
      failureReason: `reconciler_${decision.status}`,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.kycSessions.kind, 'customer' as const),
        eq(schema.kycSessions.id, session.id),
        inArray(schema.kycSessions.status, [...PULL_OVERWRITABLE_STATUSES]),
      ),
    )
    .returning({ id: schema.kycSessions.id });
  await writeReconcilerAudit(
    db,
    'kyc_reconciler.drift_resolved',
    customerId,
    {
      action: 'session_status_synced',
      sessionId: session.id,
      diditStatus: decision.status,
      newInternalStatus: internalStatus,
    },
    now,
  );

  // Per-customer decline counter. Bump only when the reconciler is
  // the winning writer (UPDATE matched a row inside the overwritable
  // status set). Skip non-rejected terminals — `expired` /
  // `kyc_expired` aren't fraud-budget-burns. Webhook + pull surfaces
  // apply the same rule, so a single decline event increments at
  // most once across all three.
  if (updated.length > 0 && internalStatus === 'rejected') {
    await incrementDecline(db, {
      customerId,
      surface: 'reconciler',
      auditContext: EMPTY_CONTEXT,
      kycSessionId: session.id,
      now,
    });
  }
  return {
    kind: 'session_status_synced',
    sessionId: session.id,
    diditStatus: decision.status,
    newInternalStatus: internalStatus,
  };
}

async function writeReconcilerAudit(
  db: CrivacyDatabase,
  action:
    | 'kyc_reconciler.drift_detected'
    | 'kyc_reconciler.drift_resolved'
    | 'kyc_reconciler.skipped_revoked_customer'
    | 'kyc_reconciler.phase_address_missing_identity_prereq'
    | 'kyc_reconciler.reverse_drift_resolved'
    | 'kyc_reconciler.stuck_mint_detected'
    | 'kyc_reconciler.stuck_mint_resolved'
    | 'kyc_reconciler.stuck_nft_mint_detected'
    | 'kyc_reconciler.stuck_nft_mint_resolved',
  // Audit target id — `customer` for the forward + reverse passes;
  // for the stuck-mint pass we pass the `kyc_credentials_meta.id`
  // because the row, not the customer, is the unit of work and B2B
  // candidates have no customer row at all. The `target` builder
  // accepts either; the caller picks the kind via the audit action
  // meta.
  targetId: string,
  meta: Readonly<Record<string, unknown>>,
  now: Date,
): Promise<void> {
  // Stuck-mint + stuck-NFT-mint audits target the credential meta row
  // (uuid) rather than a customer row. `credential` is the existing
  // audit target kind for credential lifecycle events.
  const target =
    action === 'kyc_reconciler.stuck_mint_detected' ||
    action === 'kyc_reconciler.stuck_mint_resolved' ||
    action === 'kyc_reconciler.stuck_nft_mint_detected' ||
    action === 'kyc_reconciler.stuck_nft_mint_resolved'
      ? uuidTarget({ kind: 'credential', id: targetId })
      : uuidTarget({ kind: 'customer', id: targetId });
  await writeAudit(db, {
    action,
    actor: systemActor('kyc-reconciler'),
    target,
    context: EMPTY_CONTEXT,
    meta,
    ts: now,
  });
}

/* ---------- Cycle runner ---------- */

/**
 * Run a single reconciliation cycle. Picks up to `maxPerCycle` drift
 * candidates and reconciles each in turn. Errors raised by an
 * individual customer's branch are caught + audited so a single bad
 * row cannot abort the whole cycle.
 */
export async function runReconciliationCycle(
  deps: KycReconcilerWorkerDeps & { readonly boss: PgBoss; readonly config: KycReconcilerConfig },
): Promise<{
  readonly scanned: number;
  readonly outcomes: readonly ReconcileOutcome[];
  readonly reverseScanned: number;
  readonly reverseOutcomes: readonly ReverseDriftOutcome[];
  readonly stuckMintScanned: number;
  readonly stuckMintOutcomes: readonly StuckMintOutcome[];
  readonly orphanNftScanned: number;
  readonly orphanNftOutcomes: readonly OrphanNftOutcome[];
}> {
  const { db, logger, boss, config } = deps;
  if (config.disabled) {
    logger?.info('[kyc-reconciler] disabled via env, cycle skipped');
    return {
      scanned: 0,
      outcomes: [],
      reverseScanned: 0,
      reverseOutcomes: [],
      stuckMintScanned: 0,
      stuckMintOutcomes: [],
      orphanNftScanned: 0,
      orphanNftOutcomes: [],
    };
  }

  const candidates = await findDriftCandidates(db, {
    lookbackHours: config.lookbackHours,
    maxPerCycle: config.maxPerCycle,
  });
  logger?.info('[kyc-reconciler] cycle started', {
    candidates: candidates.length,
    lookbackHours: config.lookbackHours,
    maxPerCycle: config.maxPerCycle,
  });

  // Conditional spread keeps `exactOptionalPropertyTypes: true` happy:
  // `undefined` is not assignable to optional fields, only an absent key.
  const throttle = buildThrottle(config.throttleMs, {
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
  });
  const apiKeyFailureStreak = createFailureStreakCounter(
    logger,
    API_KEY_FAILURE_STREAK_ALERT_THRESHOLD,
  );
  const now = new Date();
  const outcomes: ReconcileOutcome[] = [];

  for (const candidate of candidates) {
    try {
      const outcome = await reconcileCustomer(
        { db, boss, logger, throttle, apiKeyFailureStreak, now },
        candidate.customerId,
      );
      outcomes.push(outcome);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger?.error('[kyc-reconciler] reconcileCustomer threw, continuing cycle', {
        customerId: candidate.customerId,
        error: errorMessage,
      });
      await writeReconcilerAudit(
        db,
        'kyc_reconciler.drift_detected',
        candidate.customerId,
        { outcome: 'reconciler_internal_error', errorMessage },
        now,
      );
      outcomes.push({
        kind: 'didit_transient_error',
        sessionId: null,
        errorCode: 'reconciler_internal_error',
        errorMessage,
      });
    }
  }

  // Reverse-drift pass — independent of the forward pass and of the
  // Didit GET budget (no HTTP traffic), so always runs even when the
  // forward pass returned zero candidates. Self-throttling: the
  // `revokeActiveKycSessions` helper is a single bulk UPDATE per
  // customer, so the per-cycle ceiling alone caps the work.
  const reverseCandidates = await findReverseDriftCandidates(db, {
    maxPerCycle: config.maxPerCycle,
  });
  logger?.info('[kyc-reconciler] reverse-drift pass started', {
    candidates: reverseCandidates.length,
  });

  const reverseOutcomes: ReverseDriftOutcome[] = [];
  for (const candidate of reverseCandidates) {
    try {
      const outcome = await reconcileReverseDriftCustomer(
        { db, now },
        candidate.customerId,
      );
      reverseOutcomes.push(outcome);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger?.error('[kyc-reconciler] reverse-drift reconcile threw, continuing cycle', {
        customerId: candidate.customerId,
        error: errorMessage,
      });
      reverseOutcomes.push({ kind: 'reverse_drift_noop', customerId: candidate.customerId });
    }
  }

  // Stuck-mint pass (Sprint 9 Faz 1.5) — the third drift surface.
  // Forward pass catches Approved Didit decisions that never made it
  // to the credential pipeline; reverse pass closes orphan sessions
  // for revoked customers; this third pass catches the case where
  // the pipeline DID run (a `kyc_credentials_meta` row was inserted)
  // but `status='pending'` outlives every pg-boss retry window. No
  // Didit GET budget is consumed — the entire query is local.
  const stuckMintCandidates = await findStuckMintCandidates(db, {
    thresholdMs: STUCK_MINT_THRESHOLD_MS,
    maxPerCycle: config.maxPerCycle,
  });
  logger?.info('[kyc-reconciler] stuck-mint pass started', {
    candidates: stuckMintCandidates.length,
    thresholdMs: STUCK_MINT_THRESHOLD_MS,
  });

  const stuckMintOutcomes: StuckMintOutcome[] = [];
  for (const candidate of stuckMintCandidates) {
    try {
      const outcome = await reconcileStuckMint({ db, boss, now }, candidate);
      stuckMintOutcomes.push(outcome);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger?.error('[kyc-reconciler] stuck-mint reconcile threw, continuing cycle', {
        metaId: candidate.metaId,
        kycSessionId: candidate.kycSessionId,
        error: errorMessage,
      });
      stuckMintOutcomes.push({
        kind: 'stuck_mint_skipped',
        metaId: candidate.metaId,
        reason: 'enqueue_returned_null',
      });
    }
  }

  // Orphan-NFT-mint pass — the fourth drift surface. Catches the narrow case
  // where the user-triggered `/api/customer/credential/mint-nft` endpoint
  // crashed mid-handler after the chain accepted the mint (the contract's
  // one-token-per-customer guard ⇒ the token exists) but before the post-mint
  // DB UPDATE landed. No Didit traffic; one cheap `tokenOfCustomer` read per
  // candidate.
  const { getFheClient } = await import('@crivacy-fhe/credential');
  const fheClient = getFheClient();
  const orphanNftCandidates = await findOrphanNftCandidates(db, {
    thresholdMs: ORPHAN_NFT_THRESHOLD_MS,
    maxPerCycle: config.maxPerCycle,
  });
  logger?.info('[kyc-reconciler] orphan-nft pass started', {
    candidates: orphanNftCandidates.length,
    thresholdMs: ORPHAN_NFT_THRESHOLD_MS,
  });
  const orphanNftOutcomes: OrphanNftOutcome[] = [];
  for (const candidate of orphanNftCandidates) {
    try {
      const outcome = await reconcileOrphanNft(
        { db, fhe: fheClient, now },
        candidate,
      );
      orphanNftOutcomes.push(outcome);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger?.error('[kyc-reconciler] orphan-nft reconcile threw, continuing cycle', {
        metaId: candidate.metaId,
        error: errorMessage,
      });
      orphanNftOutcomes.push({
        kind: 'orphan_nft_skipped',
        metaId: candidate.metaId,
        reason: 'chain_lookup_failed',
      });
    }
  }

  logger?.info('[kyc-reconciler] cycle finished', {
    scanned: candidates.length,
    outcomeCounts: countOutcomes(outcomes),
    reverseScanned: reverseCandidates.length,
    reverseResolved: reverseOutcomes.filter((o) => o.kind === 'reverse_drift_resolved').length,
    stuckMintScanned: stuckMintCandidates.length,
    stuckMintResolved: stuckMintOutcomes.filter((o) => o.kind === 'stuck_mint_resolved').length,
    orphanNftScanned: orphanNftCandidates.length,
    orphanNftResolved: orphanNftOutcomes.filter((o) => o.kind === 'orphan_nft_resolved').length,
  });
  return {
    scanned: candidates.length,
    outcomes: Object.freeze(outcomes),
    reverseScanned: reverseCandidates.length,
    reverseOutcomes: Object.freeze(reverseOutcomes),
    stuckMintScanned: stuckMintCandidates.length,
    stuckMintOutcomes: Object.freeze(stuckMintOutcomes),
    orphanNftScanned: orphanNftCandidates.length,
    orphanNftOutcomes: Object.freeze(orphanNftOutcomes),
  };
}

function countOutcomes(outcomes: readonly ReconcileOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
  }
  return counts;
}

/* ---------- pg-boss registration ---------- */

/**
 * Register the reconciler with pg-boss: schedules the cron + starts
 * the worker. Idempotent — calling twice replaces the schedule, the
 * underlying advisory lock prevents concurrent cycles across replicas.
 *
 * The handler is wired with `batchSize: 1`. Cycles are bounded by
 * `MAX_PER_CYCLE` so concurrency above 1 would only multiply the
 * Didit RPS without unlocking new candidates.
 */
export async function registerKycReconcilerWorker(
  boss: PgBoss,
  deps: KycReconcilerWorkerDeps,
): Promise<void> {
  const config = loadKycReconcilerConfig();
  if (config.disabled) {
    deps.logger?.info('[kyc-reconciler] disabled via env, worker not started');
    return;
  }

  // pg-boss v10 dropped auto-create-on-schedule; the queue MUST exist
  // before `boss.schedule()` or the call throws "Queue X not found".
  // `createQueue` is idempotent at the API level — second call is a
  // no-op if the queue already exists. See queue.ts:18-27 for the
  // historical context (F-KYC-A55-RT-008 P1).
  await boss.createQueue(KYC_RECONCILER_QUEUE);

  await boss.schedule(KYC_RECONCILER_QUEUE, config.cron, undefined, { tz: 'UTC' });

  await boss.work(KYC_RECONCILER_QUEUE, { batchSize: 1 }, async () => {
    await runReconciliationCycle({ ...deps, boss, config });
  });

  deps.logger?.info('[kyc-reconciler] worker registered', {
    cron: config.cron,
    lookbackHours: config.lookbackHours,
    maxPerCycle: config.maxPerCycle,
    throttleMs: config.throttleMs,
  });
}

/* ---------- Re-exports for tests / ops scripts ---------- */

// Re-export so tests + ops scripts don't need a private import path.
export { CREDENTIAL_PIPELINE_QUEUE };
