/**
 * Customer-layer error taxonomy.
 * @module
 */

export type CustomerErrorCode =
  | 'email_already_registered'
  | 'email_not_verified'
  | 'invalid_verification_token'
  | 'expired_verification_token'
  | 'already_verified'
  | 'invalid_reset_token'
  | 'expired_reset_token'
  | 'reset_token_used'
  | 'account_locked'
  | 'account_banned'
  | 'account_suspended'
  | 'invalid_credentials'
  | 'weak_password'
  | 'turnstile_failed'
  | 'max_attempts_exceeded'
  | 'kyc_fields_immutable'
  | 'code_expired'
  | 'code_invalid'
  | 'code_max_attempts'
  | 'code_invalidated'
  | 'code_rate_limited'
  | 'session_superseded'
  | 'oauth_failed'
  | 'oauth_email_required'
  | 'oauth_state_mismatch'
  | 'oauth_account_not_linked'
  | 'wallet_challenge_invalid'
  | 'wallet_signature_invalid'
  | 'completion_token_expired'
  | 'completion_token_invalid';

export class CustomerError extends Error {
  readonly code: CustomerErrorCode;

  constructor(code: CustomerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CustomerError';
    this.code = code;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, CustomerError);
    }
  }
}

export function isCustomerError(value: unknown): value is CustomerError {
  return value instanceof CustomerError;
}
