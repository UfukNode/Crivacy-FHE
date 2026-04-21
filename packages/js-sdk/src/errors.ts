/**
 * Crivacy OAuth SDK error taxonomy.
 *
 * Every helper in this package throws `CrivacyOauthError` (and only
 * that) on failure — one catch covers them all. The `.code` field
 * mirrors the standard OAuth 2.0 / RFC 9700 error vocabulary plus a
 * small set of SDK-specific states (state mismatch, missing verifier
 * in storage, etc.) that only the client side can detect.
 *
 * @module
 */

export type CrivacyOauthErrorCode =
  // RFC 6749 standard errors echoed from the server
  | 'invalid_request'
  | 'unauthorized_client'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'invalid_grant'
  | 'invalid_client'
  | 'redirect_uri_mismatch'
  | 'invalid_token'
  | 'expired_token'
  | 'consent_required'
  | 'consent_scope_escalation'
  // PKCE-specific
  | 'pkce_invalid'
  | 'pkce_required'
  // SDK-side client state failures
  | 'state_mismatch'
  | 'missing_verifier'
  | 'storage_unavailable'
  | 'not_a_callback'
  | 'network_error'
  // verifyDisclosure-side failures (claims missing the on-chain pointer)
  | 'disclosure_blob_missing'
  | 'disclosure_contract_id_missing'
  | 'disclosure_user_missing'
  | 'disclosure_contract_missing'
  | 'unknown_error';

export interface CrivacyOauthErrorOptions {
  /**
   * Additional human-readable description, typically the server's
   * `error_description` field. Safe to log and display.
   */
  readonly description?: string;
  /**
   * The `state` value the server echoed back, when present.
   */
  readonly state?: string;
  /**
   * The raw underlying error, if any. Wraps native fetch / storage
   * errors so callers can drill down without losing the stack trace.
   */
  readonly cause?: unknown;
}

export class CrivacyOauthError extends Error {
  readonly code: CrivacyOauthErrorCode;
  readonly description?: string;
  readonly state?: string;

  constructor(
    code: CrivacyOauthErrorCode,
    message: string,
    options: CrivacyOauthErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CrivacyOauthError';
    this.code = code;
    if (options.description !== undefined) this.description = options.description;
    if (options.state !== undefined) this.state = options.state;
  }
}

export function isCrivacyOauthError(value: unknown): value is CrivacyOauthError {
  return value instanceof CrivacyOauthError;
}
