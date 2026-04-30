/**
 * Observability barrel export.
 *
 * Single import point for all observability primitives:
 *   - Logger (pino, structured JSON, PII redaction)
 *   - Metrics (prom-client, Prometheus exposition)
 *   - Tracing (OTel SDK, OTLP gRPC → Tempo)
 *   - Request metrics (per-request recording helpers)
 *
 * @module
 */

// --- Errors ---
export { ObservabilityError, isObservabilityError } from './errors';
export type { ObservabilityErrorCode } from './errors';
export { OBSERVABILITY_ERROR_CODES } from './errors';

// --- Config ---
export {
  getObservabilityConfig,
  loadObservabilityConfig,
  resetObservabilityConfigForTests,
} from './config';
export type { ObservabilityConfig } from './config';

// --- Logger ---
export { childLogger, createLogger, getRootLogger, resetRootLoggerForTests } from './logger';
export type { LogContext, Logger } from './logger';

// --- Metrics ---
export {
  auditEventsTotal,
  authAttemptsTotal,
  chainSubmitDurationSeconds,
  chainSubmitErrorsTotal,
  dbQueryDurationSeconds,
  getRegistry,
  httpRequestDurationSeconds,
  httpRequestSizeBytes,
  httpRequestsTotal,
  httpResponseSizeBytes,
  initDefaultMetrics,
  kycSessionOutcomesTotal,
  kycSessionsCreatedTotal,
  quotaUsageRatio,
  rateLimitDenialsTotal,
  resetMetricsForTests,
  webhookCircuitBreakersOpen,
  webhookDeliveriesTotal,
  webhookDeliveryDurationSeconds,
} from './metrics';
export { promClient } from './metrics';

// --- Tracing ---
export { getTracer, initTracing, resetTracingForTests, withSpan, withSpanSync } from './tracing';

// --- Request metrics ---
export {
  normalizeRoutePath,
  recordAuthAttempt,
  recordRateLimitDenial,
  recordRequestMetrics,
} from './request-metrics';
export type { RequestMetricInput } from './request-metrics';
