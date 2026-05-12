/**
 * Single source of truth for "is this customer's credential mint
 * currently in flight, retrying, or exhausted?" projection.
 *
 * Why this exists
 * ---------------
 * Pre-Sprint MP the gap between "Didit returned approved" and "the
 * chain commit landed in `kyc_credentials_meta`" was invisible to
 * the customer. The /kyc page rendered the parent step as either
 * `active` ("Start verification" CTA — false negative) or
 * `completed` (✓ green — false positive) depending on whether the
 * atomic mint TX had bumped `customer.kyc_level` yet. A real-world
 * mint that hit a 10s submit-and-wait timeout and went into pg-boss
 * retry would sit in this gap for minutes and the customer would
 * conclude their Approved decision had been lost.
 *
 * The fix is to surface the gap explicitly: while there is a
 * credential-pipeline job in `created` / `active` / `retry`, this
 * projector returns a `MintProgress` record so the stepper can
 * render an animated "Issuing credential on Sepolia…" sub-step.
 *
 * Output contract
 * ---------------
 *   * `null` — the customer is not in the mint window for this
 *     phase. Either Didit hasn't returned a positive decision yet,
 *     OR the mint already landed (the meta row exists and the level
 *     is bumped — the registry's level-based status takes over).
 *   * `MintProgress` — the gap. State + attempt counters mirror
 *     pg-boss's job row directly (no derived counters), so the
 *     stepper's "attempt 2 of 6" copy is auditable from a single DB
 *     query.
 *
 * @module
 */

import { sql, eq } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import type { MintProgress } from '@/lib/kyc/phase-registry';

interface ResolveMintProgressParams {
  /** The kyc_session row this projector is asking about. */
  readonly kycSessionId: string;
  /**
   * Current backend status of that session row. Mint progress only
   * exists when this is the phase-specific terminal-positive value
   * (`identity_approved` for identity, `approved` for address);
   * any other status returns `null` immediately.
   */
  readonly sessionStatus: string;
  /**
   * Phase the caller is asking about. Drives both the
   * `sessionStatus` gate above and the pg-boss data-filter below
   * (jobs are keyed by `(kycSessionId, phase)`).
   */
  readonly phase: 'identity' | 'address';
}

/**
 * Phase-specific terminal-positive `kyc_sessions.status` value that
 * opens the mint window. Identity reaches `identity_approved`
 * (intermediate — address verification is a separate phase that
 * promotes the credential further); address reaches `approved` as
 * the workflow's final terminal state.
 */
function isTerminalPositive(phase: 'identity' | 'address', status: string): boolean {
  return phase === 'identity' ? status === 'identity_approved' : status === 'approved';
}

/**
 * Resolve the mint-window state for a single phase's session.
 *
 * Cost: at most two single-row queries (one Drizzle, one raw against
 * `pgboss.job`). Both are indexed (kyc_session_id PK on the meta
 * table; pg-boss has its own internal index on `name`).
 */
export async function resolveMintProgress(
  db: CrivacyDatabase,
  params: ResolveMintProgressParams,
): Promise<MintProgress | null> {
  if (!isTerminalPositive(params.phase, params.sessionStatus)) {
    return null;
  }

  // Step 1 — has the mint already landed? If a kyc_credentials_meta
  // row exists for this session id (regardless of whether it has
  // since been superseded by the address-phase upgrade), the
  // customer's level was bumped atomically with the INSERT. The
  // phase registry's level-based step status takes over from here;
  // we return `null` so the stepper shows the canonical ✓ instead
  // of an animated "issuing" row that would never resolve.
  const metaRows = await db
    .select({ id: schema.kycCredentialsMeta.id })
    .from(schema.kycCredentialsMeta)
    .where(eq(schema.kycCredentialsMeta.kycSessionId, params.kycSessionId))
    .limit(1);
  if (metaRows.length > 0) {
    return null;
  }

  // Step 2 — pg-boss job lookup. We query `pgboss.job` directly
  // (no Drizzle schema for it) because pg-boss owns that table's
  // shape. `data->>'kycSessionId'` + `data->>'phase'` selectivity
  // is high enough that the unindexed JSON path is fine for a
  // status-endpoint call: there is at most one in-flight job per
  // (session, phase) due to the `singletonKey` upstream and the
  // history is naturally short.
  let jobRow: { state: string; retry_count: number; retry_limit: number } | null = null;
  try {
    const jobResult = await db.execute<{
      state: string;
      retry_count: number;
      retry_limit: number;
    }>(
      sql`SELECT state, retry_count, retry_limit
            FROM pgboss.job
           WHERE name = 'credential-pipeline'
             AND data->>'kycSessionId' = ${params.kycSessionId}
             AND data->>'phase' = ${params.phase}
           ORDER BY created_on DESC
           LIMIT 1`,
    );
    jobRow = jobResult.rows[0] ?? null;
  } catch (rawErr) {
    const err = rawErr as Error & { code?: string; detail?: string; hint?: string; cause?: unknown };
    // eslint-disable-next-line no-console
    console.error('[mint-progress] pgboss SELECT failed', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      hint: err.hint,
      cause: err.cause instanceof Error
        ? { name: err.cause.name, message: err.cause.message, code: (err.cause as { code?: string }).code }
        : err.cause,
    });
    // Fail soft, but do NOT hide the mint window. We only reach this
    // query AFTER confirming the session is terminal-positive (approved)
    // AND no credential row exists yet, so a mint IS in flight. If the
    // pgboss read is unavailable (e.g. the app DB role lacks pgboss
    // schema access), returning null would make `mintProgress` null and
    // the stepper would never show the "Issuing credential on Sepolia…"
    // row. Degrade to `pending` instead — the accurate retry counters
    // are a nice-to-have; showing the minting step at all is the point.
    return { state: 'pending', attempts: 1, totalAttempts: 6 };
  }

  if (jobRow === null) {
    // Approved decision in, no job row yet — either the worker
    // hasn't fetched the freshly-enqueued job or the queue is empty
    // because the job was archived after success but the meta-row
    // INSERT is still in flight (vanishing race window). Show
    // `pending` either way; SWR/SSE refresh will tighten this on
    // the next poll cycle. Total budget mirrors the
    // `enqueueCredentialPipeline` constant (`retryLimit: 5` →
    // 6 total attempts).
    return { state: 'pending', attempts: 1, totalAttempts: 6 };
  }

  const totalAttempts = jobRow.retry_limit + 1;
  const attempts = jobRow.retry_count + 1;

  if (jobRow.state === 'failed') {
    return { state: 'failed', attempts, totalAttempts };
  }
  if (jobRow.state === 'completed') {
    // pg-boss says completed but no meta row — extremely narrow
    // race (worker just finished, INSERT not visible to this
    // transaction's snapshot). Treat as no-window so the stepper
    // does not flash a "still issuing" row in the millisecond gap.
    return null;
  }
  if (jobRow.state === 'retry' && jobRow.retry_count > 0) {
    return { state: 'retrying', attempts, totalAttempts };
  }
  // `created` | `active` | `retry` with retry_count = 0 — first
  // attempt scheduled or in flight. `pending` covers all three from
  // the customer's perspective (no retry has been observed yet).
  return { state: 'pending', attempts, totalAttempts };
}
