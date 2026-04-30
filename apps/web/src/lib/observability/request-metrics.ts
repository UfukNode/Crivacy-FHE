/**
 * Request-level metrics recording.
 *
 * Called by middleware at the end of each request to record:
 *   - HTTP request count (total)
 *   - HTTP request duration (histogram)
 *   - Auth attempts (counter)
 *   - Rate limit denials (counter)
 *
 * All functions are side-effect-only (void return, never throw).
 * A broken metrics pipeline must never break request handling.
 *
 * @module
 */

import type { Logger } from 'pino';

import {
  authAttemptsTotal,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  rateLimitDenialsTotal,
} from './metrics';

// ---------------------------------------------------------------------------
// Route normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a URL path to a route template for metrics labels.
 * Replaces UUIDs and numeric IDs with `:id` to avoid label cardinality explosion.
 *
 * Examples:
 *   /api/v1/sessions/abc-123-def → /api/v1/sessions/:id
 *   /api/v1/credentials/550e8400.../verify → /api/v1/credentials/:id/verify
 */
export function normalizeRoutePath(path: string): string {
  // UUID v4 pattern
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  // Pure numeric IDs
  const numericPattern = /\/(\d{2,})(\/|$)/g;

  let normalized = path.replace(uuidPattern, ':id');
  normalized = normalized.replace(numericPattern, '/:id$2');

  return normalized;
}

// ---------------------------------------------------------------------------
// Request recording
// ---------------------------------------------------------------------------

export interface RequestMetricInput {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly authTier: 'public' | 'firm' | 'dashboard' | 'admin' | 'webhook';
}

/**
 * Record HTTP request metrics. Called at the end of every request.
 * Never throws — metrics failures are silently logged.
 */
export function recordRequestMetrics(input: RequestMetricInput, logger?: Logger): void {
  try {
    const route = normalizeRoutePath(input.path);
    const statusStr = String(input.status);
    const durationSec = input.durationMs / 1000;

    httpRequestsTotal.inc({
      method: input.method,
      path: route,
      status: statusStr,
      auth_tier: input.authTier,
    });

    httpRequestDurationSeconds.observe(
      {
        method: input.method,
        path: route,
        status: statusStr,
        auth_tier: input.authTier,
      },
      durationSec,
    );
  } catch (err) {
    if (logger !== undefined) {
      logger.warn({ err }, 'Failed to record request metrics');
    }
  }
}

// ---------------------------------------------------------------------------
// Auth recording
// ---------------------------------------------------------------------------

/**
 * Record an authentication attempt. Call from every place that
 * decides whether a caller is who they claim to be:
 *
 *   * `api_key`  — `/api/v1/*` X-API-Key header validation.
 *   * `jwt`      — cookie-based session verification in the
 *     customer / dashboard / admin route middlewares. One call per
 *     request; failure covers signature-invalid, session-revoked,
 *     session-expired, and "session not found" alike.
 *   * `password` — the interactive login step in
 *     customer / firm / admin login handlers. Highest-signal
 *     credential-stuffing indicator — a sudden spike here fires the
 *     `CrivacyAuthFailureSpike` Prometheus alert (see
 *     `infra/prometheus/alert-rules.yml`).
 *   * `totp`     — second-factor verification (TOTP setup verify,
 *     login-challenge TOTP, reauth TOTP).
 *   * `wallet`   — chain wallet signature verification on
 *     `/auth/wallet/verify` + `/wallet/link` + wallet-reauth paths.
 *
 * The helper is non-throwing by design: prom-client counter writes
 * can fail on metric registry corruption or similar. Losing a data
 * point is strictly better than breaking the caller's auth decision.
 */
export function recordAuthAttempt(
  method: 'api_key' | 'jwt' | 'totp' | 'password' | 'wallet',
  result: 'success' | 'failure' | 'expired',
): void {
  try {
    authAttemptsTotal.inc({ method, result });
  } catch {
    // Metrics failure must not break auth
  }
}

// ---------------------------------------------------------------------------
// Rate limit recording
// ---------------------------------------------------------------------------

/**
 * Record a rate limit denial.
 */
export function recordRateLimitDenial(tier: string, reason: 'bucket' | 'quota'): void {
  try {
    rateLimitDenialsTotal.inc({ tier, reason });
  } catch {
    // Metrics failure must not break rate limiting
  }
}
