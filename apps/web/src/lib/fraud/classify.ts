/**
 * Fraud classification for Didit KYC decisions.
 *
 * Analyzes a raw Didit webhook body for fraud signals that go beyond
 * a normal decline. Normal declines (blurry photo, mismatched name)
 * are expected and the customer gets retry attempts. Fraud signals
 * (tampering, spoofing, replay) trigger an immediate permanent ban
 * via the ban orchestrator.
 *
 * The classifier operates on the raw webhook body (which uses
 * `.passthrough()` in the Zod schema) rather than the typed
 * `DiditDecisionPayload` — the fraud-specific fields like
 * `tampering_detected`, `spoofing_detected`, `replay_detected`
 * are passthrough fields that Didit includes but we do not type
 * in the standard decision payload.
 *
 * Classification rules:
 *
 *   1. `document.tampering_detected === true` → fraud_document
 *   2. `face_match.spoofing_detected === true` → fraud_identity
 *   3. `liveness.replay_detected === true` → fraud_liveness
 *   4. `document.authentication === 'FAILED'` → fraud_document
 *   5. `face_match.score < 20 AND liveness.score < 20` simultaneously
 *      → fraud_combined (two extremely low scores together are a
 *      strong signal of a synthetic identity attack)
 *
 * If none of the above match, the decision is a `normal_decline` and
 * the customer is allowed to retry (up to the max attempts limit).
 *
 * @module
 */

import type { FraudReason } from './types';

/* ---------- Types ---------- */

/**
 * Classification outcome from a declined Didit decision.
 *
 *   * `normal_decline` — customer failed verification but no fraud
 *     signals present; retries are permitted.
 *   * `fraud` — one or more fraud signals detected; the customer
 *     should be permanently banned.
 */
export type FraudClassification = 'normal_decline' | 'fraud';

/**
 * A single detected fraud signal with its machine-readable name and
 * the reason enum value for the blacklist table.
 */
export interface FraudSignal {
  /** Human-readable signal name for audit meta. */
  readonly name: string;
  /** Database enum value for the `customer_blacklist.reason` column. */
  readonly reason: FraudReason;
}

/* ---------- Internal helpers ---------- */

/**
 * Safely read a nested boolean field from an untyped record.
 * Returns `false` if the path does not exist or is not boolean.
 */
function readBool(obj: unknown, key: string): boolean {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  const value = (obj as Record<string, unknown>)[key];
  return value === true;
}

/**
 * Safely read a nested number field from an untyped record.
 * Returns `null` if the path does not exist or is not a finite number.
 */
function readNumber(obj: unknown, key: string): number | null {
  if (typeof obj !== 'object' || obj === null) {
    return null;
  }
  const value = (obj as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

/**
 * Safely read a nested string field from an untyped record.
 * Returns `null` if the path does not exist or is not a string.
 */
function readString(obj: unknown, key: string): string | null {
  if (typeof obj !== 'object' || obj === null) {
    return null;
  }
  const value = (obj as Record<string, unknown>)[key];
  if (typeof value !== 'string') {
    return null;
  }
  return value;
}

/* ---------- Combined score threshold ---------- */

/**
 * When both face_match.score and liveness.score are below this
 * threshold simultaneously, we classify as fraud_combined. This
 * threshold is intentionally very low (20 out of 100) to avoid
 * false positives — legitimate users rarely score this low on
 * both checks at once.
 */
const COMBINED_LOW_SCORE_THRESHOLD = 20;

/* ---------- Public API ---------- */

/**
 * Extract all detected fraud signals from a raw Didit webhook body.
 *
 * The body is expected to be the JSON-parsed webhook payload — the
 * same object stored in `customer_kyc_sessions.didit_decision_payload`.
 * Passthrough fields from `.passthrough()` in the Zod schema carry
 * the fraud-specific attributes.
 *
 * Returns an empty array when no fraud is detected. The order of
 * signals is deterministic (document → identity → liveness → combined)
 * so audit logs are stable.
 */
export function extractFraudSignals(webhookBody: unknown): readonly FraudSignal[] {
  if (typeof webhookBody !== 'object' || webhookBody === null) {
    return [];
  }

  const raw = webhookBody as Record<string, unknown>;
  const signals: FraudSignal[] = [];

  // 1. Document tampering
  if (readBool(raw['kyc'], 'tampering_detected')) {
    signals.push({
      name: 'document_tampering_detected',
      reason: 'fraud_document',
    });
  }

  // 2. Document authentication failure
  if (readString(raw['kyc'], 'authentication') === 'FAILED') {
    signals.push({
      name: 'document_authentication_failed',
      reason: 'fraud_document',
    });
  }

  // 3. Face match spoofing
  if (readBool(raw['face_match'], 'spoofing_detected')) {
    signals.push({
      name: 'face_spoofing_detected',
      reason: 'fraud_identity',
    });
  }

  // 4. Liveness replay
  if (readBool(raw['liveness'], 'replay_detected')) {
    signals.push({
      name: 'liveness_replay_detected',
      reason: 'fraud_liveness',
    });
  }

  // 5. Combined low scores — both face_match AND liveness below threshold
  const faceMatchScore = readNumber(raw['face_match'], 'score');
  const livenessScore = readNumber(raw['liveness'], 'score');
  if (
    faceMatchScore !== null &&
    livenessScore !== null &&
    faceMatchScore < COMBINED_LOW_SCORE_THRESHOLD &&
    livenessScore < COMBINED_LOW_SCORE_THRESHOLD
  ) {
    signals.push({
      name: 'combined_low_scores',
      reason: 'fraud_combined',
    });
  }

  return signals;
}

/**
 * Classify a declined Didit decision as either a normal decline or
 * fraud. Uses `extractFraudSignals` under the hood — if any signal
 * is present, the classification is `fraud`.
 *
 * This function should only be called for decisions with status
 * `Declined` — calling it on `Approved` or `In Progress` decisions
 * is a logic error (the caller should check the status first).
 */
export function classifyDecision(webhookBody: unknown): FraudClassification {
  const signals = extractFraudSignals(webhookBody);
  return signals.length > 0 ? 'fraud' : 'normal_decline';
}

/**
 * Pick the most severe fraud reason from a list of signals. Uses
 * a priority order: combined > liveness > identity > document.
 * Returns `'fraud_combined'` as the default when the list is empty
 * (should never happen — caller should check `signals.length > 0`).
 */
export function pickFraudReason(signals: readonly FraudSignal[]): FraudReason {
  // Priority: combined > liveness > identity > document
  const priorityOrder: readonly FraudReason[] = [
    'fraud_combined',
    'fraud_liveness',
    'fraud_identity',
    'fraud_document',
  ];
  const reasons = new Set(signals.map((s) => s.reason));
  for (const reason of priorityOrder) {
    if (reasons.has(reason)) {
      return reason;
    }
  }
  // Fallback — should not be reached when signals.length > 0
  return 'fraud_combined';
}
