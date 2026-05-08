/**
 * OAuth layer error taxonomy.
 *
 * Every helper in `@/lib/oauth` throws `OauthError` (and only
 * `OauthError`) when it fails. One class, discriminated by `.code`,
 * matches the pattern used by `AuthError` / `RbacError` / `AdminError`
 * so the error-mapper can map cleanly to the RFC 6749 / 9700 error
 * vocabulary on the wire.
 *
 * @module
 */

export type OauthErrorCode =
  // Authorization request / authorize endpoint
  | 'invalid_request'
  | 'invalid_client'
  | 'unauthorized_client'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  | 'temporarily_unavailable'
  // Token / code exchange
  | 'invalid_grant'
  | 'invalid_code'
  | 'expired_code'
  | 'used_code'
  | 'code_reuse_detected'
  | 'pkce_required'
  | 'pkce_invalid'
  | 'ip_bind_mismatch'
  // Client / registration
  | 'redirect_uri_mismatch'
  | 'client_secret_required'
  | 'client_revoked'
  // Consent
  | 'consent_required'
  | 'consent_scope_escalation'
  | 'consent_revoked'
  // Access token
  | 'invalid_token'
  | 'expired_token'
  | 'revoked_token'
  | 'insufficient_scope'
  // Authorization request
  | 'request_not_found'
  | 'request_expired'
  | 'request_ip_mismatch'
  // Config
  | 'config_invalid';

export class OauthError extends Error {
  readonly code: OauthErrorCode;
  readonly detail?: string;

  constructor(
    code: OauthErrorCode,
    message: string,
    options?: { cause?: unknown; detail?: string },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OauthError';
    this.code = code;
    if (options?.detail !== undefined) this.detail = options.detail;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, OauthError);
    }
  }
}

export function isOauthError(value: unknown): value is OauthError {
  return value instanceof OauthError;
}
