/**
 * Per-customer Didit decline counter — anti-budget-burn gate.
 *
 * Sister to `lib/fraud/ip-abuse.ts` (per-IP gate). Where IP-abuse trips
 * on `face_match_blocked` only, this trips on every decline regardless
 * of cause: a customer who keeps failing OCR / DB-validation / liveness
 * still burns Didit budget on every attempt and gets free signal on
 * which fields pass which checks. After `THRESHOLD` consecutive declines
 * within the cooldown window the next start-* call is rejected with
 * HTTP 429 BEFORE going to Didit.
 *
 * State lives on `customers.consecutive_kyc_declines` +
 * `customers.last_decline_at` (migration `20260510180000`). The counter
 * is a single source of truth; webhook + SSE pull-fallback + reconciler
 * forward-drift all funnel decline detection through `incrementDecline`,
 * and the credential-pipeline-worker calls `resetDecline` inside the
 * mint TX so the counter resets atomically with the level bump.
 *
 * Cascade-ban interaction: `cascadeBan` already locks the account via
 * `customers.locked_at` (indefinite). We deliberately skip
 * `incrementDecline` on cascade-banned declines (caller passes
 * `skipFraudOverride: true`) so the cascade-ban audit telemetry is the
 * single signal the SOC sees for that customer.
 *
 * Knobs (all `KYC_DECLINE_*`):
 *   - `KYC_DECLINE_THRESHOLD` — default 3. Number of consecutive
 *     declines that trips the lock.
 *   - `KYC_DECLINE_COOLDOWN_HOURS` — default 24. How long after the
 *     latest decline the lock stays effective.
 *
 * No env-var fallback hardcodes — both knobs read at call time so
 * test setups can override per-case.
 */

import { eq, sql } from 'drizzle-orm';

import { systemActor } from '@/lib/audit/actors';
import type { AuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

export const KYC_DECLINE_DEFAULT_THRESHOLD = 3;
export const KYC_DECLINE_DEFAULT_COOLDOWN_HOURS = 24;

function readThreshold(): number {
  const raw = process.env['KYC_DECLINE_THRESHOLD'];
  if (raw === undefined || raw.length === 0) return KYC_DECLINE_DEFAULT_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : KYC_DECLINE_DEFAULT_THRESHOLD;
}

function readCooldownHours(): number {
  const raw = process.env['KYC_DECLINE_COOLDOWN_HOURS'];
  if (raw === undefined || raw.length === 0) return KYC_DECLINE_DEFAULT_COOLDOWN_HOURS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : KYC_DECLINE_DEFAULT_COOLDOWN_HOURS;
}

/* -------------------------------------------------------------------------- */
/*  Lock evaluation                                                           */
/* -------------------------------------------------------------------------- */

export interface DeclineLockState {
  /** True when the customer is currently locked out of start-* calls. */
  readonly locked: boolean;
  /** Current consecutive-decline count (zero-clamped read). */
  readonly count: number;
  /** Threshold at evaluation time (echoes env knob). */
  readonly threshold: number;
  /**
   * UTC timestamp when the lock expires. Null when the customer has
   * no recorded decline OR the cooldown already elapsed (in which
   * case `locked = false`).
   */
  readonly cooldownEndsAt: Date | null;
}

/**
 * Compute the current lock state for the supplied customer row. Pure
 * function — does not touch the DB; the caller is expected to have
 * already loaded `(consecutive_kyc_declines, last_decline_at)`. Used
 * by the start-* gate (handed the row from its existing lookup) AND
 * by the read-side surfaces (admin UI, /kyc/status response) so
 * everyone agrees on "is this customer locked right now".
 */
export function evaluateDeclineLock(
  customer: {
    readonly consecutiveKycDeclines: number;
    readonly lastDeclineAt: Date | null;
  },
  now: Date = new Date(),
  threshold: number = readThreshold(),
  cooldownHours: number = readCooldownHours(),
): DeclineLockState {
  const count = Math.max(0, customer.consecutiveKycDeclines);
  if (count < threshold || customer.lastDeclineAt === null) {
    return { locked: false, count, threshold, cooldownEndsAt: null };
  }
  const cooldownEndsAt = new Date(
    customer.lastDeclineAt.getTime() + cooldownHours * 60 * 60 * 1000,
  );
  if (cooldownEndsAt.getTime() <= now.getTime()) {
    // Cooldown elapsed. Counter is stale — the next decline will
    // rebase it, the next approve will reset it. Read-side surfaces
    // surface "not locked" so the customer can retry.
    return { locked: false, count, threshold, cooldownEndsAt: null };
  }
  return { locked: true, count, threshold, cooldownEndsAt };
}

/* -------------------------------------------------------------------------- */
/*  Mutations — single SoT for decline / approve transitions                  */
/* -------------------------------------------------------------------------- */

export interface IncrementDeclineParams {
  readonly customerId: string;
  /**
   * Source surface — webhook / pull / reconciler. Audit meta only;
   * does not change behaviour. Mirrors the
   * `face-match-dispatch.FaceMatchSurface` discriminator pattern.
   */
  readonly surface: 'webhook' | 'pull_fallback' | 'reconciler';
  /** Audit-context for the resulting `fraud.kyc_decline_strike` row. */
  readonly auditContext: AuditRequestContext;
  /**
   * Used in audit meta so a SOC can join from this row to the
   * specific session that drove the decline.
   */
  readonly kycSessionId: string;
  /** UTC clock used for the UPDATE + audit timestamps. */
  readonly now: Date;
}

export interface IncrementDeclineResult {
  /** Post-increment value of `consecutive_kyc_declines`. */
  readonly count: number;
  /** True iff this increment crossed (or matched) the threshold. */
  readonly thresholdCrossed: boolean;
  /** Threshold at increment time. */
  readonly threshold: number;
}

/**
 * Atomic increment + last_decline_at stamp + audit. Idempotent within
 * a single decline event but NOT between events — calling this twice
 * for the same session would double-count, so wire each detection
 * surface (webhook OR pull OR reconciler) so only the *winning*
 * writer increments. The current pattern is "the first writer that
 * transitions session.status -> rejected calls this". The losing
 * writer's `UPDATE ... WHERE status IN (...)` returns 0 rows and
 * the caller short-circuits before reaching this helper.
 */
export async function incrementDecline(
  db: CrivacyDatabase,
  params: IncrementDeclineParams,
): Promise<IncrementDeclineResult> {
  const threshold = readThreshold();

  const updated = await db
    .update(schema.customers)
    .set({
      consecutiveKycDeclines: sql`${schema.customers.consecutiveKycDeclines} + 1`,
      lastDeclineAt: params.now,
      updatedAt: params.now,
    })
    .where(eq(schema.customers.id, params.customerId))
    .returning({
      count: schema.customers.consecutiveKycDeclines,
    });

  const count = updated[0]?.count ?? 0;
  const thresholdCrossed = count >= threshold;

  await writeAudit(db, {
    action: 'fraud.kyc_decline_strike',
    actor: systemActor(`decline-counter:${params.surface}`),
    target: uuidTarget({ kind: 'customer', id: params.customerId }),
    context: params.auditContext,
    meta: {
      surface: params.surface,
      kycSessionId: params.kycSessionId,
      count,
      threshold,
      thresholdCrossed,
    },
    ts: params.now,
  });

  return { count, thresholdCrossed, threshold };
}

/**
 * Reset the counter on a successful credential issue. Safe to call
 * inside the mint TX (the credential-pipeline-worker already owns a
 * tx for the meta INSERT + level/score UPDATE; this one piggybacks
 * on the same write batch via the `tx` argument).
 *
 * Idempotent: writing 0 over 0 is a no-op as far as application
 * behaviour goes. The audit row is only emitted when the counter
 * was actually non-zero so we don't spam the SOC with no-op rows
 * on every approval.
 */
export async function resetDecline(
  db: CrivacyDatabase,
  params: {
    readonly customerId: string;
    readonly auditContext: AuditRequestContext;
    readonly kycSessionId: string;
    readonly now: Date;
  },
): Promise<{ readonly previousCount: number }> {
  // Read prior counter before the UPDATE so the audit row's
  // `previousCount` is meaningful. Both queries inside the same
  // `db` (or `tx`) — when the caller passes a tx, both run inside
  // the mint transaction so they see a consistent snapshot.
  const prior = await db
    .select({ count: schema.customers.consecutiveKycDeclines })
    .from(schema.customers)
    .where(eq(schema.customers.id, params.customerId))
    .limit(1);
  const previousCount = prior[0]?.count ?? 0;

  await db
    .update(schema.customers)
    .set({
      consecutiveKycDeclines: 0,
      lastDeclineAt: null,
      updatedAt: params.now,
    })
    .where(eq(schema.customers.id, params.customerId));

  if (previousCount > 0) {
    await writeAudit(db, {
      action: 'fraud.kyc_decline_reset',
      actor: systemActor('decline-counter:approve'),
      target: uuidTarget({ kind: 'customer', id: params.customerId }),
      context: params.auditContext,
      meta: {
        kycSessionId: params.kycSessionId,
        previousCount,
      },
      ts: params.now,
    });
  }

  return { previousCount };
}

/* -------------------------------------------------------------------------- */
/*  Test-only helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Read a customer's counter state directly. Used by tests to assert
 * the increment / reset wire-up; not for production hot-path reads
 * (those go through `evaluateDeclineLock` after a single SELECT in
 * the start-* handler).
 */
export async function getDeclineState(
  db: CrivacyDatabase,
  customerId: string,
): Promise<{ readonly count: number; readonly lastDeclineAt: Date | null }> {
  const rows = await db
    .select({
      count: schema.customers.consecutiveKycDeclines,
      lastDeclineAt: schema.customers.lastDeclineAt,
    })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { count: 0, lastDeclineAt: null };
  return { count: row.count, lastDeclineAt: row.lastDeclineAt };
}
