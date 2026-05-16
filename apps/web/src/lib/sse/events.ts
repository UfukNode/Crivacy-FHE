/**
 * SSE event types for the customer KYC flow.
 *
 * Each constant maps to a dot-delimited event name that the client listens
 * for via `EventSource.addEventListener(name, ...)`. The naming follows the
 * same `<domain>.<verb>` convention used in audit actions.
 */

export const KYC_EVENTS = {
  /** Fired when the KYC session status transitions (e.g. pending -> in_progress -> approved). */
  STATUS_CHANGED: 'kyc.status_changed',
  /** Fired when a discrete step within the workflow completes (e.g. liveness check passed). */
  STEP_COMPLETED: 'kyc.step_completed',
  /**
   * Fired when a device-handoff token is consumed on the phone. This is
   * the moment the desktop UI knows "the user is now in the Didit flow
   * on their phone" and can swap the QR card for a "verification opened
   * on your phone, continue there" panel — matches the Stripe Identity /
   * Persona / Onfido cross-device handoff UX.
   *
   * Detected by the SSE poll loop: it watches `kycDeviceHandoffs.consumedAt`
   * for sessions belonging to the current customer and emits when a row
   * transitions from un-consumed → consumed. DB-driven, so the event
   * flows correctly across replicas without a cross-process pub/sub.
   */
  HANDOFF_CONSUMED: 'kyc.handoff_consumed',
  /** Fired when a credential is successfully issued and confirmed on-chain. */
  CREDENTIAL_ISSUED: 'credential.issued',
  /** Fired when a credential is revoked (self-revoke or admin-revoke). */
  CREDENTIAL_REVOKED: 'credential.revoked',
  /** Fired when a credential is upgraded (e.g. phase 1 -> phase 2 address verification). */
  CREDENTIAL_UPGRADED: 'credential.upgraded',
} as const;

export type KycEventType = (typeof KYC_EVENTS)[keyof typeof KYC_EVENTS];

// ---------------------------------------------------------------------------
// Type-safe event data interfaces
// ---------------------------------------------------------------------------

/** Payload for `kyc.status_changed` events. */
export interface KycStatusChangedData {
  readonly sessionId: string;
  readonly workflow: string;
  readonly status: string;
  readonly kycLevel: string;
  readonly kycScore: number;
}

/** Payload for `kyc.step_completed` events. */
export interface KycStepCompletedData {
  readonly sessionId: string;
  readonly workflow: string;
  readonly step: string;
}

/** Payload for `kyc.handoff_consumed` events. */
export interface KycHandoffConsumedData {
  readonly sessionId: string;
}

/** Payload for `credential.issued` events. */
export interface CredentialIssuedData {
  readonly credentialId: string;
  readonly level: string;
  readonly score: number;
}

/** Payload for `credential.revoked` events. */
export interface CredentialRevokedData {
  readonly credentialId: string;
  readonly reason: string;
}

/** Payload for `credential.upgraded` events. */
export interface CredentialUpgradedData {
  readonly credentialId: string;
  readonly previousLevel: string;
  readonly newLevel: string;
  readonly newScore: number;
  readonly supersededCredentialIds: readonly string[];
}
