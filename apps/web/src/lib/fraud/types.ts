/**
 * Shared types for the fraud detection module.
 *
 * The `FraudReason` type mirrors the `fraud_reason` pgEnum in
 * `schema/enums.ts` so the fraud module can reference the enum
 * values without importing Drizzle schema types directly.
 *
 * @module
 */

/**
 * Fraud reason values that map to the `fraud_reason` Postgres enum.
 * Must be kept in sync with `fraudReasonEnum` in `schema/enums.ts`.
 */
export type FraudReason =
  | 'fraud_document'
  | 'fraud_identity'
  | 'fraud_liveness'
  | 'fraud_combined'
  | 'manual_ban';
