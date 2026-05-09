/**
 * Cascade-ban orchestrator — Sprint 6's response to a `cascade_fraud`
 * face-match evaluation. Fires when either:
 *
 *   * The current attempt's face matched a previously-banned account
 *     (scenario 5 — `reasonCode === 'matched_banned_account'`), OR
 *   * Didit ran a fraud signal directly on the session payload
 *     (scenario 6 — `reasonCode` is one of `DIDIT_FRAUD_SIGNAL_CODES`).
 *
 * The handler dispatches to one of two paths based on the session
 * context:
 *
 *   * `customer` flow → call `banCustomer()`. That helper already
 *     covers status flip, blacklist insert (with `face_hash`), chain
 *     revoke, KYC session revoke, auth session revoke, audit batch.
 *     We layer one extra `fraud.cascade_banned` audit row on top so
 *     the SOC dashboard can filter cascade-driven bans separately
 *     from admin-manual or fraud-signal-direct bans.
 *
 *   * `b2b` flow → no customer record to ban. Insert a blacklist row
 *     with `face_hash` populated (so a future face_search 1:N return
 *     of the just-attempted session id trips the gate) and write the
 *     same audit row. The webhook handler still flips the kyc_session
 *     status to `rejected` and emits `kyc.session.rejected` to the
 *     firm — that's its existing reject path, untouched.
 *
 * `face_hash` semantics: we hash the CURRENT session's id (not the
 * matched session's). The next attempter whose face hits face_search
 * will get THIS session id back as a match → webhook handler hashes
 * the match → finds it in the blacklist → cascade fires again. The
 * matched session ids in `evaluation.resolvedMatches` belong to
 * already-banned accounts and need no extra row.
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';
import type { AuditRequestContext } from '@/lib/audit/context';
import { systemActor } from '@/lib/audit/actors';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { DIDIT_FRAUD_SIGNAL_SET, type DiditRiskCode } from '@crivacy-fhe/adapter-didit/risk-codes';

import { addToBlacklist, hashFace } from './blacklist';
import { banCustomer, type BanResult } from './ban';
import type { FaceMatchContext, FaceMatchEvaluation, ResolvedMatch } from './face-match';
import type { FraudReason } from './types';

/**
 * Discriminant of the cascade-ban call. Matches `FaceMatchContext`'s
 * shape so the caller can hand the same context object straight
 * through. Kept as a separate alias so future B2B-only fields
 * (signing-firm metadata, etc.) can be added without leaking back
 * into the evaluator.
 */
export type CascadeBanContext = FaceMatchContext;

export interface CascadeBanInput {
  /**
   * The cascade_fraud branch of the evaluator output. Pinned via
   * the `kind` discriminant so a stray `no_match` result cannot
   * accidentally enter the cascade path.
   */
  readonly evaluation: Extract<FaceMatchEvaluation, { kind: 'cascade_fraud' }>;
  readonly context: CascadeBanContext;
  /** The CURRENT session id (the attempt that just got rejected). */
  readonly currentDiditSessionId: string;
  /**
   * For `b2b` context only: the UUID of the `kyc_sessions` row this
   * cascade is anchored on. Used as the audit `target_id` since B2B
   * flow has no customer record to point at. Ignored on `customer`
   * context (the customer id is the natural target there).
   */
  readonly b2bKycSessionId?: string | undefined;
  readonly auditContext: AuditRequestContext;
  readonly now: Date;
}

export interface CascadeBanResult {
  /** The face_hash written to the blacklist row. */
  readonly faceHash: string;
  /**
   * The blacklist row id (always populated — both customer and B2B
   * paths persist a row).
   */
  readonly blacklistId: string;
  /**
   * Populated only on the `customer` path. Contains the per-channel
   * revoke counts that `banCustomer` returned, so the caller can
   * stamp them on its own audit row if it wants.
   */
  readonly banResult: BanResult | null;
}

/**
 * Map a Sprint 6 cascade `reasonCode` to the Postgres `fraud_reason`
 * enum value persisted on the blacklist row. The mapping mirrors the
 * priority ranking in `risk-codes.ts::DIDIT_DECLINE_REASON_PRIORITY`:
 * face-anchored signals (`LIVENESS_FACE_ATTACK`, blocklist hits,
 * matched-banned cascade) → `fraud_identity`; document-anchored
 * tampering → `fraud_document`. The synthetic `matched_banned_account`
 * is identity-anchored — the cascade fires because the FACE matched a
 * banned account, not because of anything documentary.
 */
function reasonCodeToFraudReason(
  reasonCode: DiditRiskCode | 'matched_banned_account',
): FraudReason {
  if (reasonCode === 'matched_banned_account') return 'fraud_identity';
  switch (reasonCode) {
    case 'LIVENESS_FACE_ATTACK':
      return 'fraud_liveness';
    case 'FACE_IN_BLOCKLIST':
      return 'fraud_identity';
    case 'PORTRAIT_MANIPULATION_DETECTED':
    case 'PRINTED_COPY_DETECTED':
    case 'SCREEN_CAPTURE_DETECTED':
    case 'ID_DOCUMENT_IN_BLOCKLIST':
      return 'fraud_document';
    default:
      // Any future fraud-signal code we haven't mapped explicitly —
      // default to combined so the row carries SOMETHING. The catch-
      // all triggers only when `evaluation.reasonCode` is in the
      // fraud-signal SET but missing from the switch above; we log
      // that drift in the caller's audit meta so ops can patch the
      // mapping.
      return DIDIT_FRAUD_SIGNAL_SET.has(reasonCode) ? 'fraud_combined' : 'fraud_identity';
  }
}

/**
 * Project the resolved matches into a stable audit-friendly shape.
 * The full `ResolvedMatch[]` is too verbose for the meta column
 * (and includes redundant fields); the projection keeps the
 * essentials.
 */
function projectMatchesForAudit(
  matches: readonly ResolvedMatch[],
): readonly Record<string, unknown>[] {
  return matches.map((r) => ({
    matchedSessionId: r.match.sessionId,
    similarity: r.match.similarityPercentage,
    statusKind: r.status.kind,
    ...(r.status.kind === 'customer_clean' || r.status.kind === 'customer_banned'
      ? { matchedCustomerId: r.status.customerId }
      : {}),
    ...(r.status.kind === 'b2b_only'
      ? { matchedFirmId: r.status.firmId, matchedUserRef: r.status.userRef }
      : {}),
  }));
}

/**
 * Run the cascade-ban flow.
 *
 * Returns the persisted face_hash + blacklist id so the webhook
 * handler can include them in its own kyc_failed / rejected audit
 * meta for cross-correlation. Throws on DB / chain failures the
 * downstream helpers themselves throw on (e.g. customer not found
 * on the customer path) — the webhook caller catches and 200-acks
 * so Didit does not retry against a state we can't recover from.
 */
export async function cascadeBan(
  db: CrivacyDatabase,
  input: CascadeBanInput,
): Promise<CascadeBanResult> {
  const faceHash = hashFace(input.currentDiditSessionId);
  const fraudReason = reasonCodeToFraudReason(input.evaluation.reasonCode);
  const auditMeta: Record<string, unknown> = {
    reasonCode: input.evaluation.reasonCode,
    diditSessionId: input.currentDiditSessionId,
    faceHash,
    matches: projectMatchesForAudit(input.evaluation.resolvedMatches),
  };

  if (input.context.kind === 'customer') {
    // Customer path — banCustomer covers status, blacklist (incl
    // face_hash + email_hash), chain revoke, KYC + auth session
    // revoke, and the standard 3-row audit batch. We add ONE extra
    // audit row on top so the cascade trail is queryable without
    // joining through fraudSignals meta.
    const banResult = await banCustomer(db, {
      customerId: input.context.customerId,
      reason: fraudReason,
      source: 'didit_webhook',
      diditSessionId: input.currentDiditSessionId,
      faceHash,
      auditContext: input.auditContext,
      fraudSignals:
        input.evaluation.reasonCode === 'matched_banned_account'
          ? ['matched_banned_account']
          : [input.evaluation.reasonCode],
    });

    await writeAudit(db, {
      action: 'fraud.cascade_banned',
      actor: systemActor('didit-webhook'),
      target: uuidTarget({ kind: 'customer', id: input.context.customerId }),
      context: input.auditContext,
      meta: {
        ...auditMeta,
        blacklistId: banResult.blacklistId,
        credentialsRevoked: banResult.credentialsRevoked,
        sessionsRevoked: banResult.sessionsRevoked,
        kycSessionsRevoked: banResult.kycSessionsRevoked,
      },
      ts: input.now,
    });

    return {
      faceHash,
      blacklistId: banResult.blacklistId,
      banResult,
    };
  }

  // B2B path — no customer record to ban; just persist the face
  // anchor + audit. The caller (handleB2bWebhook) handles the
  // session-level rejection + firm webhook emit on its own
  // existing reject path.
  const blacklistEntry = await addToBlacklist(db, {
    emailHash: null,
    reason: fraudReason,
    source: 'didit_webhook',
    diditSessionId: input.currentDiditSessionId,
    faceHash,
    notes: `B2B cascade — firm=${input.context.firmId} userRef=${input.context.userRef}`,
  });

  await writeAudit(db, {
    action: 'fraud.cascade_banned',
    actor: systemActor('didit-webhook'),
    target:
      input.b2bKycSessionId !== undefined
        ? uuidTarget({ kind: 'kyc_session', id: input.b2bKycSessionId })
        : uuidTarget({ kind: 'firm', id: input.context.firmId }),
    context: input.auditContext,
    meta: {
      ...auditMeta,
      blacklistId: blacklistEntry.id,
      firmId: input.context.firmId,
      userRef: input.context.userRef,
      ...(input.b2bKycSessionId !== undefined
        ? { kycSessionId: input.b2bKycSessionId }
        : {}),
    },
    ts: input.now,
  });

  return {
    faceHash,
    blacklistId: blacklistEntry.id,
    banResult: null,
  };
}
