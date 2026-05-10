/**
 * Webhook delivery library — barrel export.
 *
 * Pure functions for retry scheduling, HMAC signing, envelope building,
 * circuit breaker evaluation, and event fan-out. The pg-boss job handler
 * in `src/server/jobs/` consumes these.
 *
 * @module
 */

// Errors
export { WebhookError, isWebhookError, isWebhookErrorWithCode } from './errors';
export type { WebhookErrorCode } from './errors';
export { WEBHOOK_ERROR_CODES } from './errors';

// Config
export {
  getWebhookConfig,
  loadWebhookConfig,
  loadWebhookConfigFromEnv,
  resetWebhookConfigForTests,
} from './config';
export type { WebhookConfig } from './config';

// Retry
export {
  DEFAULT_RETRY_DELAYS_SECONDS,
  computeNextRetryAt,
  formatRetryDelay,
  getRetryDelaySeconds,
  isMaxAttemptsReached,
} from './retry';

// Signature
export {
  DEFAULT_TOLERANCE_SECONDS,
  DELIVERY_ID_HEADER,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  buildSignedPayload,
  buildWebhookHeaders,
  computeHmac,
  parseSignatureHeader,
  signWebhookPayload,
  verifyWebhookSignature,
} from './signature';

// Envelope
export { buildEnvelope, serializeEnvelope } from './envelope';
export type { BuildEnvelopeInput, WebhookEnvelope } from './envelope';

// Delivery
export { executeDelivery, isTransientFailure } from './delivery';
export type {
  DeliveryFailure,
  DeliveryInput,
  DeliveryResult,
  DeliverySuccess,
  FetchLike,
} from './delivery';

// Circuit breaker
export {
  computeCircuitBreakerUpdate,
  evaluateCircuitBreaker,
  isCircuitBreakerOpen,
} from './circuit-breaker';
export type { CircuitBreakerAction, CircuitBreakerState } from './circuit-breaker';

// Fan-out
export { fanOutEvent } from './fan-out';
export type { FanOutDeps, FanOutEndpoint, FanOutInput, FanOutResult } from './fan-out';

// Central emission helpers
export { emitFirmEvent, emitUserEvent } from './emit';
export type { EmitFirmEventInput, EmitResult, EmitUserEventInput } from './emit';
