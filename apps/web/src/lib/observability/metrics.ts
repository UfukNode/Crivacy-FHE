/**
 * Prometheus metrics registry — prom-client based.
 *
 * All metrics are registered on the default registry and use a configurable
 * prefix (default: `crivacy_`). The `/metrics` endpoint exposes them in
 * Prometheus exposition format.
 *
 * Metric naming follows Prometheus conventions:
 *   - counter: `<prefix>http_requests_total`
 *   - histogram: `<prefix>http_request_duration_seconds`
 *   - gauge: `<prefix>active_connections`
 *
 * @module
 */

import client from 'prom-client';

import { isMaintenanceMode } from '@/lib/env/maintenance';

import type { ObservabilityConfig } from './config';
import { getObservabilityConfig } from './config';

// ---------------------------------------------------------------------------
// Registry & default metrics
// ---------------------------------------------------------------------------

const registry = new client.Registry();

let defaultMetricsInitialized = false;

/**
 * Initialize default Node.js metrics (event loop lag, heap, etc.).
 * Idempotent — safe to call multiple times.
 */
export function initDefaultMetrics(config?: ObservabilityConfig): void {
  if (defaultMetricsInitialized) return;
  const cfg = config ?? getObservabilityConfig();
  if (!cfg.metricsEnabled) return;

  client.collectDefaultMetrics({
    register: registry,
    prefix: cfg.metricsPrefix,
  });

  // Kill-switch gauge snapshot — read once at metrics init to match
  // the memoised contract of `isMaintenanceMode()`. A maintenance
  // flag change requires process restart, so the gauge is
  // deliberately frozen for the lifetime of this registry. Errors
  // are swallowed so a metrics-init hiccup never breaks the actual
  // kill-switch path (which gates every request via middleware,
  // fully independent of the Prometheus registry).
  try {
    maintenanceModeGauge.set(isMaintenanceMode() ? 1 : 0);
  } catch {
    // intentionally swallowed — see block comment above.
  }

  defaultMetricsInitialized = true;
}

/**
 * Get the Prometheus registry. Used by the /metrics endpoint.
 */
export function getRegistry(): client.Registry {
  return registry;
}

// ---------------------------------------------------------------------------
// HTTP metrics
// ---------------------------------------------------------------------------

export const httpRequestsTotal = new client.Counter({
  name: 'crivacy_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status', 'auth_tier'] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'crivacy_http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'path', 'status', 'auth_tier'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestSizeBytes = new client.Histogram({
  name: 'crivacy_http_request_size_bytes',
  help: 'HTTP request body size in bytes',
  labelNames: ['method', 'path'] as const,
  buckets: [100, 500, 1000, 5000, 10000, 50000, 100000],
  registers: [registry],
});

export const httpResponseSizeBytes = new client.Histogram({
  name: 'crivacy_http_response_size_bytes',
  help: 'HTTP response body size in bytes',
  labelNames: ['method', 'path', 'status'] as const,
  buckets: [100, 500, 1000, 5000, 10000, 50000, 100000],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Auth metrics
// ---------------------------------------------------------------------------

export const authAttemptsTotal = new client.Counter({
  name: 'crivacy_auth_attempts_total',
  help: 'Total authentication attempts',
  labelNames: ['method', 'result'] as const, // method=api_key|jwt|totp, result=success|failure|expired
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Rate limit metrics
// ---------------------------------------------------------------------------

export const rateLimitDenialsTotal = new client.Counter({
  name: 'crivacy_ratelimit_denials_total',
  help: 'Total rate limit denials',
  labelNames: ['tier', 'reason'] as const, // reason=bucket|quota
  registers: [registry],
});

export const quotaUsageRatio = new client.Gauge({
  name: 'crivacy_quota_usage_ratio',
  help: 'Current quota usage ratio (0.0 to 1.0+)',
  labelNames: ['firm_id', 'tier'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Platform maintenance status
// ---------------------------------------------------------------------------

/**
 * Platform kill-switch state as a Prometheus gauge. Emits `1` while
 * `CRIVACY_MAINTENANCE_MODE` is active on this process, `0`
 * otherwise. Paired with `CrivacyMaintenanceActive` alert rule so
 * operators can see how long an incident-mode deployment has been
 * up and `CrivacyApiDown` can be silenced via
 * `unless on() crivacy_maintenance_mode == 1` to prevent a
 * legitimate maintenance window from paging on-call.
 *
 * Values:
 *   * `1` — `CRIVACY_MAINTENANCE_MODE=1` active, middleware returning
 *     503 to every non-exempt request. Health / status / admin paths
 *     still alive.
 *   * `0` — normal operation.
 *
 * The value is set once at metrics-registry init because
 * `isMaintenanceMode()` is memoised at process start — a maintenance
 * flag change requires a redeploy, so the gauge cannot drift mid-
 * process. Re-reading the env would invite the DB-toggle-at-rest
 * failure mode the kill-switch design explicitly rejects.
 */
export const maintenanceModeGauge = new client.Gauge({
  name: 'crivacy_maintenance_mode',
  help: 'Platform kill-switch — 1 when CRIVACY_MAINTENANCE_MODE is active, 0 otherwise',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// KYC session metrics
// ---------------------------------------------------------------------------

export const kycSessionsCreatedTotal = new client.Counter({
  name: 'crivacy_kyc_sessions_created_total',
  help: 'Total KYC sessions created',
  labelNames: ['workflow_type', 'mode'] as const, // workflow_type=kyc|address, mode=live|test
  registers: [registry],
});

export const kycSessionOutcomesTotal = new client.Counter({
  name: 'crivacy_kyc_session_outcomes_total',
  help: 'Total KYC session outcomes',
  labelNames: ['workflow_type', 'outcome'] as const, // outcome=approved|declined|pending
  registers: [registry],
});

// ---------------------------------------------------------------------------
// chain metrics
// ---------------------------------------------------------------------------

export const chainSubmitDurationSeconds = new client.Histogram({
  name: 'crivacy_chain_submit_duration_seconds',
  help: 'chain submit latency in seconds',
  labelNames: ['operation'] as const, // operation=create|verify|revoke
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const chainSubmitErrorsTotal = new client.Counter({
  name: 'crivacy_chain_submit_errors_total',
  help: 'Total chain submit errors',
  labelNames: ['operation', 'error_code'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Webhook metrics
// ---------------------------------------------------------------------------

export const webhookDeliveriesTotal = new client.Counter({
  name: 'crivacy_webhook_deliveries_total',
  help: 'Total webhook delivery attempts',
  labelNames: ['result'] as const, // result=success|failure|dead_letter
  registers: [registry],
});

export const webhookDeliveryDurationSeconds = new client.Histogram({
  name: 'crivacy_webhook_delivery_duration_seconds',
  help: 'Webhook delivery HTTP call latency in seconds',
  labelNames: ['result'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const webhookCircuitBreakersOpen = new client.Gauge({
  name: 'crivacy_webhook_circuit_breakers_open',
  help: 'Number of webhook endpoints with open circuit breakers',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Audit metrics
// ---------------------------------------------------------------------------

export const auditEventsTotal = new client.Counter({
  name: 'crivacy_audit_events_total',
  help: 'Total audit events written',
  labelNames: ['action_domain'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// DB metrics (application-level)
// ---------------------------------------------------------------------------

export const dbQueryDurationSeconds = new client.Histogram({
  name: 'crivacy_db_query_duration_seconds',
  help: 'Application-level DB query latency in seconds',
  labelNames: ['operation'] as const, // operation=select|insert|update|delete|transaction
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Reset for tests
// ---------------------------------------------------------------------------

export function resetMetricsForTests(): void {
  registry.resetMetrics();
  defaultMetricsInitialized = false;
}

// Re-export the client for type access
export { client as promClient };
