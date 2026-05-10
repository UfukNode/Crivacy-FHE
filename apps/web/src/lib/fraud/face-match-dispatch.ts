/**
 * Face-match dispatch helper — Sprint 6's shared wiring layer.
 *
 * Three call sites need to run the face-match cascade against a
 * Didit decision payload:
 *
 *   1. `handleDiditWebhook` — push channel (signed Didit webhook).
 *   2. `pullAndApplyDiditDecision` (SSE pull-fallback) — when push
 *      is dead, the SSE poll loop fetches the decision directly.
 *   3. `kyc-reconciler-worker` — periodic drift sweep when both
 *      push + pull missed (Sprint 3 safety net).
 *
 * Pre-Sprint-6 cleanup, only call site 1 had the cascade wired.
 * That left a hole: a banned face that arrived via push could be
 * re-attempted from a network where the push channel is dead, the
 * pull fallback would project Approved into the DB, and the
 * credential pipeline would mint a credential against a banned
 * biometric. Same hole on the reconciler — it would replay the
 * pipeline for a drifted-Approved session without checking the
 * face anchor.
 *
 * Two exports keep the caller in control of timing:
 *
 *   - `evaluateFaceMatchFromDecision` — runs the pure evaluator
 *     against a hydrated decision payload + ctx-injected db. Caller
 *     decides what status to persist BEFORE side-effects fire (the
 *     webhook handler demotes Approved→Rejected on cascade_fraud
 *     so the row UPDATE writes the final state in one shot).
 *
 *   - `applyFaceMatchSideEffects` — fires cascadeBan / face_match_
 *     blocked audit / IP-abuse counter increment. Idempotent on the
 *     audit-write side as far as the caller drives it (the helper
 *     itself does not dedup webhook retries; that's a separate
 *     concern handled by the route layer).
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';
import type { AuditRequestContext } from '@/lib/audit/context';
import { systemActor } from '@/lib/audit/actors';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { getRootLogger } from '@/lib/observability/logger';
import type { DiditDecisionPayload } from '@crivacy-fhe/adapter-didit/types';

import { cascadeBan } from './cascade-ban';
import { evaluateFaceMatch, type FaceMatchContext, type FaceMatchEvaluation } from './face-match';
import { createFaceMatchLookup } from './face-match-lookup';
import { hashIp, incrementSignal } from './ip-abuse';

/**
 * Result of running the cascade evaluator against a decision. The
 * `overrideReason` field tells the caller whether to demote the
 * persisted session status to `rejected` (and which reason string
 * to write into `failure_reason`).
 */
export interface FaceMatchEvaluationResult {
  readonly evaluation: FaceMatchEvaluation;
  readonly overrideReason: 'fraud_cascade' | 'face_match_blocked' | null;
}

/**
 * Run the cascade evaluator. Wraps the lookup factory + the pure
 * evaluator + branch-to-override-reason mapping so all three call
 * sites get the same logic (evaluator pure, lookup DB-injected).
 *
 * Returns `null` evaluation on internal failure — callers treat as
 * "skip cascade, continue with normal flow". The reasoning matches
 * the webhook handler's previous inline behaviour: a DB error inside
 * the lookup is an infrastructure issue, not a security gate, and
 * surfacing 5xx to Didit causes a retry storm against state we
 * already persisted.
 */
export async function evaluateFaceMatchFromDecision(
  db: CrivacyDatabase,
  decision: DiditDecisionPayload,
  context: FaceMatchContext,
): Promise<FaceMatchEvaluationResult | null> {
  try {
    const lookup = createFaceMatchLookup(db);
    const evaluation = await evaluateFaceMatch({ lookup }, decision, context);
    let overrideReason: FaceMatchEvaluationResult['overrideReason'] = null;
    if (evaluation.kind === 'cascade_fraud') {
      overrideReason = 'fraud_cascade';
    } else if (evaluation.kind === 'block_toast') {
      overrideReason = 'face_match_blocked';
    } else if (evaluation.kind === 'reuse') {
      // INFO log lives at call site so each surface stamps its own
      // identifier. The dispatch helper stays surface-agnostic.
    }
    return { evaluation, overrideReason };
  } catch (err) {
    getRootLogger().error(
      {
        event: 'face_match_eval_failed',
        contextKind: context.kind,
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'Face-match evaluation failed — continuing with normal flow',
    );
    return null;
  }
}

/**
 * Surface label — used by the IP-abuse increment audit + cascade
 * logger so SOC can filter by entry-point. Values are stable strings
 * the alert routing keys off of.
 */
export type FaceMatchSurface = 'webhook_customer' | 'webhook_b2b' | 'pull_customer' | 'reconciler_customer';

/**
 * Optional B2B-specific kyc_session uuid — needed for the cascade-ban
 * audit's target_id when context.kind === 'b2b'. The customer flow
 * uses ctx.context.customerId as the target; B2B has no customer
 * record so the kyc_session row is the natural target.
 */
export interface ApplyFaceMatchSideEffectsParams {
  readonly evaluation: FaceMatchEvaluation;
  readonly context: FaceMatchContext;
  readonly decision: DiditDecisionPayload;
  readonly currentDiditSessionId: string;
  /** B2B only — kyc_sessions.id; ignored for customer ctx. */
  readonly b2bKycSessionId?: string | undefined;
  /** Customer flow's own customer_kyc_sessions.id — meta only. */
  readonly customerKycSessionId?: string | undefined;
  /** B2B firm id — meta only (already in context for cascadeBan). */
  readonly firmIdForLogging?: string | undefined;
  readonly auditContext: AuditRequestContext;
  readonly surface: FaceMatchSurface;
  readonly now: Date;
}

/**
 * Fire the side-effects of a face-match evaluation. Caller is
 * responsible for having ALREADY persisted the session status
 * (cascade_fraud / block_toast both mean "demote to rejected" — the
 * row should be at status=rejected before this is called so that
 * `revokeActiveKycSessions` inside cascadeBan does NOT re-flip it).
 *
 * Side-effect set per branch:
 *   - `cascade_fraud` → cascadeBan + IP-abuse increment (per
 *     captured ipAddress on the decision).
 *   - `block_toast`  → fraud.face_match_blocked audit + IP-abuse
 *     increment.
 *   - `reuse` / `no_match` → nothing here (reuse-branch logging
 *     lives at call site so SOC can grep by surface).
 *
 * Errors are caught + logged; the helper does not re-throw because
 * the caller paths (webhook 200-ack, SSE poll, reconciler cycle)
 * have higher-level error handling that should not be tripped by a
 * failed audit write.
 */
export async function applyFaceMatchSideEffects(
  db: CrivacyDatabase,
  params: ApplyFaceMatchSideEffectsParams,
): Promise<void> {
  const { evaluation, context, decision, surface, now, auditContext } = params;

  if (evaluation.kind === 'cascade_fraud') {
    try {
      const result = await cascadeBan(db, {
        evaluation,
        context,
        currentDiditSessionId: params.currentDiditSessionId,
        ...(context.kind === 'b2b' && params.b2bKycSessionId !== undefined
          ? { b2bKycSessionId: params.b2bKycSessionId }
          : {}),
        auditContext,
        now,
      });
      getRootLogger().warn(
        {
          event: 'face_match_cascade_banned',
          surface,
          contextKind: context.kind,
          ...(context.kind === 'customer'
            ? { customerId: context.customerId }
            : { firmId: context.firmId, userRef: context.userRef }),
          ...(params.customerKycSessionId !== undefined
            ? { sessionId: params.customerKycSessionId }
            : {}),
          ...(params.b2bKycSessionId !== undefined
            ? { sessionId: params.b2bKycSessionId }
            : {}),
          faceHash: result.faceHash,
          blacklistId: result.blacklistId,
          reasonCode: evaluation.reasonCode,
        },
        'Sprint 6 cascade-ban fired',
      );
    } catch (cascadeErr) {
      getRootLogger().error(
        {
          event: 'face_match_cascade_ban_failed',
          surface,
          err: cascadeErr instanceof Error
            ? { name: cascadeErr.name, message: cascadeErr.message }
            : String(cascadeErr),
        },
        'cascadeBan failed — manual triage required',
      );
    }
  } else if (evaluation.kind === 'block_toast') {
    try {
      const target =
        context.kind === 'customer'
          ? uuidTarget({ kind: 'customer', id: context.customerId })
          : params.b2bKycSessionId !== undefined
          ? uuidTarget({ kind: 'kyc_session', id: params.b2bKycSessionId })
          : uuidTarget({ kind: 'firm', id: context.firmId });

      await writeAudit(db, {
        action: 'fraud.face_match_blocked',
        actor: systemActor('face-match-dispatch'),
        target,
        context: auditContext,
        meta: {
          surface,
          diditSessionId: params.currentDiditSessionId,
          matchedEmailMasked: evaluation.maskedEmail,
          matchedCustomerId:
            evaluation.resolvedMatch.status.kind === 'customer_clean'
              ? evaluation.resolvedMatch.status.customerId
              : null,
          matchedSessionId: evaluation.resolvedMatch.match.sessionId,
          similarity: evaluation.resolvedMatch.match.similarityPercentage,
          ...(context.kind === 'b2b'
            ? { firmId: context.firmId, userRef: context.userRef }
            : {}),
          ...(params.customerKycSessionId !== undefined
            ? { sessionId: params.customerKycSessionId }
            : {}),
        },
        ts: now,
      });
    } catch (auditErr) {
      getRootLogger().error(
        {
          event: 'face_match_blocked_audit_failed',
          surface,
          err: auditErr instanceof Error
            ? { name: auditErr.name, message: auditErr.message }
            : String(auditErr),
        },
        'fraud.face_match_blocked audit write failed',
      );
    }
  }

  // IP-abuse counter increment fires on BOTH cascade_fraud and
  // block_toast — both are "this IP just tried to slip a banned/
  // duplicate face past us". The pre-Didit gate at start-session
  // reads this counter to refuse the next attempt.
  if (evaluation.kind === 'cascade_fraud' || evaluation.kind === 'block_toast') {
    const seen = new Set<string>();
    for (const analysis of decision.ipAnalyses) {
      const ip = analysis.ipAddress;
      if (typeof ip !== 'string' || ip.length === 0) continue;
      if (seen.has(ip)) continue;
      seen.add(ip);
      try {
        const ipHash = hashIp(ip);
        if (ipHash.length === 0) continue;
        await incrementSignal(db, ipHash, now);
      } catch (err) {
        getRootLogger().error(
          {
            event: 'ip_abuse_increment_failed',
            surface,
            err: err instanceof Error
              ? { name: err.name, message: err.message }
              : String(err),
          },
          'IP-abuse counter increment failed — continuing',
        );
      }
    }
  }
}
