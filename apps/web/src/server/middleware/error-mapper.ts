/**
 * Error mapper — translates library errors into API responses.
 *
 * Every non-2xx response in the API uses the `ApiErrorBody` envelope.
 * This module maps the four library error classes plus `ZodError` into
 * a `{ code, message, status, details? }` tuple that the route builder
 * serializes via the context's `errorJson` helper.
 *
 * Mapping is intentionally exhaustive on the error class. Unknown errors
 * fall into `internal_error` / 500 so the caller never sees a stack
 * trace or raw exception message.
 *
 * @module
 */

import { ZodError } from 'zod';

import { AdminError, type AdminErrorCode } from '@/lib/admin/errors';
import { AuditError } from '@/lib/audit/errors';
import { AuthError, type AuthErrorCode } from '@/lib/auth/errors';
import { PwnedPasswordError } from '@/lib/auth/pwned-passwords';
import { CustomerError, type CustomerErrorCode } from '@/lib/customer/errors';
import { DiditError, type DiditErrorCode } from '@crivacy-fhe/adapter-didit/errors';
import { getRootLogger } from '@/lib/observability/logger';
import { RateLimitError } from '@/lib/ratelimit/errors';
import { RbacError, type RbacErrorCode } from '@/lib/rbac/errors';

import type { ApiErrorCode } from '@/lib/openapi/common/errors';

// ---------------------------------------------------------------------------
// Mapped result
// ---------------------------------------------------------------------------

/**
 * The error-mapper output. The route builder feeds this straight into
 * `ctx.errorJson(code, message, status, details)`.
 */
export interface MappedError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Auth error mapping
// ---------------------------------------------------------------------------

/** Map of AuthErrorCode → { ApiErrorCode, HTTP status }. */
const AUTH_ERROR_MAP: Readonly<
  Record<AuthErrorCode, { readonly code: ApiErrorCode; readonly status: number }>
> = {
  // API keys
  invalid_api_key: { code: 'invalid_api_key', status: 401 },
  api_key_mismatch: { code: 'invalid_api_key', status: 401 },
  expired_api_key: { code: 'expired_api_key', status: 401 },
  revoked_api_key: { code: 'invalid_api_key', status: 401 },
  unsupported_api_key_hash: { code: 'internal_error', status: 500 },

  // Passwords
  weak_password: { code: 'validation_failed', status: 400 },
  invalid_password: { code: 'unauthenticated', status: 401 },
  unsupported_password_hash: { code: 'internal_error', status: 500 },

  // JWT
  malformed_jwt: { code: 'invalid_session', status: 401 },
  invalid_jwt: { code: 'invalid_session', status: 401 },
  expired_jwt: { code: 'invalid_session', status: 401 },
  invalid_jwt_audience: { code: 'invalid_session', status: 401 },
  invalid_jwt_issuer: { code: 'invalid_session', status: 401 },
  jwt_missing_claim: { code: 'invalid_session', status: 401 },

  // Refresh tokens
  invalid_refresh_token: { code: 'invalid_session', status: 401 },
  refresh_token_mismatch: { code: 'invalid_session', status: 401 },

  // TOTP
  invalid_totp_code: { code: 'totp_invalid', status: 401 },
  invalid_totp_secret: { code: 'internal_error', status: 500 },
  totp_not_enrolled: { code: 'totp_required', status: 401 },
  // Recovery code (TOTP backup path). Uses a dedicated API code so
  // the UI can swap the input back to the TOTP mode after a single
  // failed redemption (per-attempt feedback), while still funnelling
  // into the same per-user attempt counter the TOTP branch uses.
  invalid_recovery_code: { code: 'recovery_code_invalid', status: 401 },

  // Crypto box
  crypto_box_invalid: { code: 'internal_error', status: 500 },
  crypto_box_unknown_key_version: { code: 'internal_error', status: 500 },
  crypto_box_invalid_key: { code: 'internal_error', status: 500 },

  // Scopes
  unknown_scope: { code: 'scope_forbidden', status: 403 },

  // Admin two-step login
  account_locked: { code: 'account_locked', status: 423 },
  challenge_invalid: { code: 'challenge_invalid', status: 401 },
  challenge_ip_mismatch: { code: 'challenge_ip_mismatch', status: 403 },

  // Firm user invitations — `not_found` stays with the shared 404
  // semantics; used/expired get their own 410 so the client can
  // render a specific "this link is no longer valid" message.
  not_found: { code: 'not_found', status: 404 },
  invite_used: { code: 'invite_used', status: 410 },
  invite_expired: { code: 'invite_expired', status: 410 },
  // Firm deactivated after the welcome email went out — same 410
  // Gone semantics as the other invite-dead-end statuses so clients
  // can treat them as one class ("this link is no longer usable")
  // while still discriminating on the `code` for the surface copy.
  invite_revoked: { code: 'invite_revoked', status: 410 },

  // Config
  auth_config_invalid: { code: 'internal_error', status: 500 },
};

function mapAuthError(err: AuthError): MappedError {
  const entry = AUTH_ERROR_MAP[err.code];
  return {
    code: entry.code,
    message: entry.status >= 500 ? 'Internal authentication error.' : err.message,
    status: entry.status,
  };
}

// ---------------------------------------------------------------------------
// Didit error mapping
// ---------------------------------------------------------------------------

/** Codes that indicate Didit webhook signature problems. */
const DIDIT_SIGNATURE_CODES: ReadonlySet<DiditErrorCode> = new Set([
  'missing_signature',
  'missing_timestamp',
  'stale_signature',
  'invalid_signature',
]);

/** Codes that indicate a Didit transport or availability problem. */
const DIDIT_UPSTREAM_CODES: ReadonlySet<DiditErrorCode> = new Set([
  'request_timeout',
  'network_error',
  'http_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'service_unavailable',
  'empty_response',
  'invalid_response',
]);

function mapDiditError(err: DiditError): MappedError {
  if (DIDIT_SIGNATURE_CODES.has(err.code)) {
    return {
      code: 'webhook_signature_invalid',
      message: 'Webhook signature verification failed.',
      status: 401,
    };
  }
  if (err.code === 'invalid_webhook_body') {
    return {
      code: 'validation_failed',
      message: 'Webhook body does not match the expected schema.',
      status: 400,
      ...(err.context !== undefined ? { details: err.context } : {}),
    };
  }
  if (DIDIT_UPSTREAM_CODES.has(err.code)) {
    return {
      code: 'didit_unavailable',
      message: 'Didit verification service is temporarily unavailable. Please retry.',
      status: 502,
    };
  }
  // Config, validation, or programmer errors → 500.
  return {
    code: 'internal_error',
    message: 'Internal Didit configuration error.',
    status: 500,
  };
}

// ---------------------------------------------------------------------------
// Customer error mapping
// ---------------------------------------------------------------------------

const CUSTOMER_ERROR_MAP: Readonly<
  Record<CustomerErrorCode, { readonly code: ApiErrorCode; readonly status: number }>
> = {
  email_already_registered: { code: 'conflict', status: 409 },
  email_not_verified: { code: 'email_not_verified', status: 403 },
  invalid_verification_token: { code: 'validation_failed', status: 400 },
  expired_verification_token: { code: 'validation_failed', status: 400 },
  already_verified: { code: 'conflict', status: 409 },
  invalid_reset_token: { code: 'validation_failed', status: 400 },
  expired_reset_token: { code: 'validation_failed', status: 400 },
  reset_token_used: { code: 'conflict', status: 409 },
  account_locked: { code: 'account_locked', status: 423 },
  account_banned: { code: 'account_banned', status: 403 },
  // Reversible suspend — distinct code so the UI can show an appeal
  // path (not "this account is banned") and support can differentiate
  // in audit queries. AUD-X-ERROR-001 fix.
  account_suspended: { code: 'account_suspended', status: 403 },
  invalid_credentials: { code: 'unauthenticated', status: 401 },
  weak_password: { code: 'validation_failed', status: 400 },
  turnstile_failed: { code: 'turnstile_failed', status: 403 },
  max_attempts_exceeded: { code: 'account_locked', status: 423 },
  kyc_fields_immutable: { code: 'validation_failed', status: 400 },
  // Phase 4: 6-digit codes
  code_expired: { code: 'code_expired', status: 400 },
  code_invalid: { code: 'code_invalid', status: 400 },
  code_max_attempts: { code: 'code_max_attempts', status: 429 },
  code_invalidated: { code: 'code_invalid', status: 400 },
  code_rate_limited: { code: 'rate_limited', status: 429 },
  // Phase 4: single session
  session_superseded: { code: 'session_superseded', status: 401 },
  // Phase 4: OAuth
  oauth_failed: { code: 'oauth_failed', status: 400 },
  oauth_email_required: { code: 'validation_failed', status: 400 },
  oauth_state_mismatch: { code: 'validation_failed', status: 400 },
  oauth_account_not_linked: { code: 'validation_failed', status: 400 },
  // Phase 4: Wallet
  wallet_challenge_invalid: { code: 'validation_failed', status: 400 },
  wallet_signature_invalid: { code: 'unauthenticated', status: 401 },
  // Phase 4: Completion
  completion_token_expired: { code: 'code_expired', status: 400 },
  completion_token_invalid: { code: 'validation_failed', status: 400 },
};

function mapCustomerError(err: CustomerError): MappedError {
  const entry = CUSTOMER_ERROR_MAP[err.code];
  return {
    code: entry.code,
    message: err.message,
    status: entry.status,
  };
}

// ---------------------------------------------------------------------------
// RBAC error mapping
// ---------------------------------------------------------------------------

const RBAC_ERROR_MAP: Readonly<
  Record<RbacErrorCode, { readonly code: ApiErrorCode; readonly status: number }>
> = {
  role_not_found: { code: 'not_found', status: 404 },
  role_already_exists: { code: 'conflict', status: 409 },
  role_is_system: { code: 'validation_failed', status: 400 },
  role_is_preset: { code: 'validation_failed', status: 400 },
  role_has_users: { code: 'conflict', status: 409 },
  permission_not_found: { code: 'not_found', status: 404 },
  permission_already_granted: { code: 'conflict', status: 409 },
  user_already_has_role: { code: 'conflict', status: 409 },
  user_role_not_found: { code: 'not_found', status: 404 },
  invalid_user_type: { code: 'validation_failed', status: 400 },
  // Runtime enforcement failure — thrown by dashboardRoute/adminRoute
  // when the resolved effective permission set is missing the code
  // the route option declared. Distinct from `role_forbidden` to
  // let the client render accurate copy.
  permission_denied: { code: 'permission_denied', status: 403 },
};

function mapRbacError(err: RbacError): MappedError {
  const entry = RBAC_ERROR_MAP[err.code];
  return {
    code: entry.code,
    message: err.message,
    status: entry.status,
  };
}

// ---------------------------------------------------------------------------
// Rate limit error mapping
// ---------------------------------------------------------------------------

function mapRateLimitError(err: RateLimitError): MappedError {
  // RateLimitError is typically an internal misconfiguration (the
  // middleware catches 429s via the decision object, not via thrown
  // errors). But if one leaks out, map it safely.
  return {
    code: 'internal_error',
    message: 'Rate limit service encountered an internal error.',
    status: 500,
    ...(err.details !== undefined ? { details: err.details } : {}),
  };
}

// ---------------------------------------------------------------------------
// Zod error mapping
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Admin error mapping
// ---------------------------------------------------------------------------

const ADMIN_ERROR_MAP: Readonly<
  Record<AdminErrorCode, { readonly code: ApiErrorCode; readonly status: number }>
> = {
  // Same slug already owned by a live firm. 409 matches the convention
  // we already use for create/update-conflict in the admin OpenAPI spec.
  firm_slug_taken: { code: 'conflict', status: 409 },
  firm_not_found: { code: 'not_found', status: 404 },
  // Restore attempted on a firm that was never soft-deleted; same
  // category as double-submit protection — surface as 409 so the UI
  // can distinguish "no action taken" from the real success case.
  firm_already_active: { code: 'conflict', status: 409 },
};

function mapAdminError(err: AdminError): MappedError {
  const entry = ADMIN_ERROR_MAP[err.code];
  return {
    code: entry.code,
    message: err.message,
    status: entry.status,
  };
}

function mapZodError(err: ZodError): MappedError {
  const issues = err.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  return {
    code: 'validation_failed',
    message: 'Request body does not match the expected schema.',
    status: 400,
    details: { issues },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map an arbitrary error to a structured API error. Returns a frozen
 * `MappedError` the route builder can serialize.
 *
 * Ordering: the most common errors (AuthError from the auth middleware,
 * ZodError from request parsing) are checked first for fast-path.
 */
export function mapErrorToResponse(err: unknown): MappedError {
  let mapped: MappedError;

  if (err instanceof PwnedPasswordError) {
    // Breached-password rejection surfaces as a 400 with the
    // `weak_password` error code so the UI shows a clear "pick a
    // different password" affordance. The raw breach count is NOT
    // echoed back — it is an attacker-side signal that our HIBP
    // check fired, nothing more.
    mapped = {
      code: 'validation_failed',
      message: err.message,
      status: 400,
    };
  } else if (err instanceof AuthError) {
    mapped = mapAuthError(err);
  } else if (err instanceof AdminError) {
    mapped = mapAdminError(err);
  } else if (err instanceof CustomerError) {
    mapped = mapCustomerError(err);
  } else if (err instanceof RbacError) {
    mapped = mapRbacError(err);
  } else if (err instanceof ZodError) {
    mapped = mapZodError(err);
  } else if (err instanceof DiditError) {
    mapped = mapDiditError(err);
  } else if (err instanceof RateLimitError) {
    mapped = mapRateLimitError(err);
  } else if (err instanceof AuditError) {
    // F-A1-AUDIT-ATOMIC-001 observability hardening: an AuditError
    // bubbling to the route boundary means the tx-aware writeAudit
    // failed and the surrounding Pattern A-in-tx region rolled back.
    // The user-visible action did NOT commit, but this is a load-
    // bearing signal — tx rollback because of an audit-write failure
    // is a compliance-relevant integrity event (NIST SP 800-92, OWASP
    // ASVS V8.6). Emit a high-severity structured log so the ops
    // pipeline (Sentry / log-aggregator alert rule) can page on it.
    // Validation-class codes (`invalid_action`, `meta_too_large`,
    // ...) are programmer errors and stay loud at error level too —
    // they only fire if a caller hands invalid input, which should
    // never reach prod.
    getRootLogger().error(
      {
        event: 'audit_write_failed_in_tx',
        code: err.code,
        message: err.message,
        ...(err.context !== undefined ? { context: err.context } : {}),
        cause:
          err.cause instanceof Error
            ? { name: err.cause.name, message: err.cause.message }
            : err.cause !== undefined
              ? String(err.cause)
              : undefined,
      },
      'audit-write failure caused tx rollback — investigate compliance impact',
    );
    mapped = {
      code: 'internal_error',
      message: 'Internal audit-log error.',
      status: 500,
    };
  } else {
    // Pino `debug` level — suppressed in prod by default, visible
    // when `LOG_LEVEL=debug` in dev. Replaces the NODE_ENV branch.
    getRootLogger().debug(
      {
        event: 'error_mapper_unhandled',
        err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      },
      'error-mapper unhandled error',
    );
    mapped = {
      code: 'internal_error',
      message: 'An unexpected error occurred.',
      status: 500,
    };
  }

  return Object.freeze(mapped);
}

/**
 * Type-guard for `MappedError`. Useful in tests.
 */
export function isMappedError(value: unknown): value is MappedError {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['code'] === 'string' && typeof obj['status'] === 'number';
}
