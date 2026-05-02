/**
 * Auth-layer error taxonomy.
 *
 * Every helper in `@/lib/auth` throws `AuthError` (and only `AuthError`)
 * when it fails. The single class deliberately replaces the legacy habit of
 * mixing `throw new Error()` strings with raw boolean returns: callers
 * always know they have a structured failure with a machine-readable
 * `.code` to map onto HTTP responses without string-matching.
 *
 * The `code` enum is intentionally narrow and concrete. Route handlers in
 * `apps/web/src/app/api/**` will branch on `error.code` to translate into
 * the OpenAPI `ApiErrorCode` taxonomy declared in
 * `src/lib/openapi/common/errors.ts`. Adding a new auth code is a documented
 * breaking change (audited via the API spec diff in CI).
 *
 * Original errors are preserved through `cause` so a Pino structured log
 * can stack them without manual concatenation. Stack traces are captured
 * the standard way; we never construct an `AuthError` from user input
 * verbatim, so message strings are safe to log.
 */

export type AuthErrorCode =
  /* API keys */
  | 'invalid_api_key' // raw key string is malformed (bad prefix, length, charset)
  | 'api_key_mismatch' // hash compare returned false
  | 'expired_api_key' // expires_at column is in the past
  | 'revoked_api_key' // revoked_at column is set
  | 'unsupported_api_key_hash' // hashAlgorithm column references an unknown algorithm
  /* Passwords */
  | 'weak_password' // does not meet `passwordMinLength`
  | 'invalid_password' // verify returned false
  | 'unsupported_password_hash' // hash string format unknown
  /* JWT */
  | 'malformed_jwt' // could not parse the compact serialization
  | 'invalid_jwt' // signature failed
  | 'expired_jwt' // exp claim is in the past
  | 'invalid_jwt_audience' // aud claim does not match the verifier's expectation
  | 'invalid_jwt_issuer' // iss claim does not match
  | 'jwt_missing_claim' // a required custom claim was absent
  /* Refresh tokens */
  | 'invalid_refresh_token' // raw token bytes don't decode
  | 'refresh_token_mismatch' // hash compare failed
  /* TOTP */
  | 'invalid_totp_code' // verify returned false (or wrong drift)
  | 'invalid_totp_secret' // could not decode the Base32 input
  | 'totp_not_enrolled' // user has no totp_secret_ciphertext stored
  /* Recovery codes (TOTP backup path) */
  | 'invalid_recovery_code' // hash did not match any unused row for this user
  /* Crypto box */
  | 'crypto_box_invalid' // ciphertext failed authentication tag check
  | 'crypto_box_unknown_key_version' // sealed box references a key version we cannot load
  | 'crypto_box_invalid_key' // raw key buffer is the wrong length
  /* Scopes */
  | 'unknown_scope' // string is not a member of `ApiKeyScope`
  /* Admin two-step login */
  | 'account_locked' // admin account is temporarily locked
  | 'challenge_invalid' // challenge token expired, used, or attempts exhausted
  | 'challenge_ip_mismatch' // step 2 IP does not match step 1 IP
  /* Firm user invitations */
  | 'not_found' // invitation token did not match any row
  | 'invite_used' // token was already consumed
  | 'invite_expired' // expires_at timestamp is in the past
  | 'invite_revoked' // target firm was deactivated after the invite went out
  /* Config */
  | 'auth_config_invalid'; // env failed Zod validation

/**
 * Single concrete error class for the entire auth layer.
 *
 * The class is final by convention — do not subclass it. Discrimination is
 * done via the `code` field; this keeps `instanceof AuthError` reliable
 * across the whole codebase regardless of how a value travels through
 * promise chains, structured-clone boundaries, or test mocks.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthError';
    this.code = code;
    // Capture a clean stack trace pointing at the throw site, not the
    // constructor itself. `Error.captureStackTrace` only exists on V8.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, AuthError);
    }
  }
}

/**
 * Type guard. Useful in catch blocks where TypeScript narrows `unknown`
 * via the `is` predicate without forcing an `instanceof` cast.
 */
export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}

/**
 * Convenience: assert that an unknown value is an `AuthError` with one
 * of the listed codes. Used in tests to keep failure assertions terse
 * (`expectAuthError(err, 'invalid_jwt', 'expired_jwt')`).
 */
export function isAuthErrorWithCode<C extends AuthErrorCode>(
  value: unknown,
  ...codes: readonly C[]
): value is AuthError & { code: C } {
  return value instanceof AuthError && (codes as readonly string[]).includes(value.code);
}
