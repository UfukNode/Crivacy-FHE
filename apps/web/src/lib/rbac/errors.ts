/**
 * RBAC-layer error taxonomy.
 *
 * Every helper in `@/lib/rbac` throws `RbacError` (and only `RbacError`)
 * when it fails. The single class follows the same pattern as `AuthError`
 * in `@/lib/auth/errors`: callers branch on the machine-readable `.code`
 * to map onto HTTP responses without string-matching.
 *
 * Route handlers in `apps/web/src/app/api/**` translate `error.code` into
 * the OpenAPI `ApiErrorCode` taxonomy declared in
 * `src/lib/openapi/common/errors.ts`. Adding a new RBAC code is a
 * documented breaking change (audited via the API spec diff in CI).
 *
 * Original errors are preserved through `cause` so Pino structured logs
 * can stack them. Stack traces are captured the standard way; we never
 * construct an `RbacError` from user input verbatim, so message strings
 * are safe to log.
 */

export type RbacErrorCode =
  | 'role_not_found'
  | 'role_already_exists'
  | 'role_is_system'
  | 'role_is_preset'
  | 'role_has_users'
  | 'permission_not_found'
  | 'permission_already_granted'
  | 'user_already_has_role'
  | 'user_role_not_found'
  | 'invalid_user_type'
  // Runtime enforcement failure (route middleware fires this when the
  // caller lacks the permission declared by the route option). Distinct
  // from `role_forbidden` (hierarchy-based) so the client can render
  // "Your role does not allow this action" with accurate copy instead
  // of "Insufficient role" which implies the user should ask for a
  // higher role (irrelevant under permission-based enforcement).
  | 'permission_denied';

/**
 * Single concrete error class for the entire RBAC layer.
 *
 * The class is final by convention — do not subclass it. Discrimination is
 * done via the `code` field; this keeps `instanceof RbacError` reliable
 * across the whole codebase regardless of how a value travels through
 * promise chains, structured-clone boundaries, or test mocks.
 */
export class RbacError extends Error {
  readonly code: RbacErrorCode;

  constructor(code: RbacErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RbacError';
    this.code = code;
    // Capture a clean stack trace pointing at the throw site, not the
    // constructor itself. `Error.captureStackTrace` only exists on V8.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, RbacError);
    }
  }
}

/**
 * Type guard. Useful in catch blocks where TypeScript narrows `unknown`
 * via the `is` predicate without forcing an `instanceof` cast.
 */
export function isRbacError(value: unknown): value is RbacError {
  return value instanceof RbacError;
}

/**
 * Convenience: assert that an unknown value is an `RbacError` with one
 * of the listed codes. Used in tests to keep failure assertions terse
 * (`expectRbacError(err, 'role_not_found', 'role_is_system')`).
 */
export function isRbacErrorWithCode<C extends RbacErrorCode>(
  value: unknown,
  ...codes: readonly C[]
): value is RbacError & { readonly code: C } {
  return value instanceof RbacError && (codes as readonly string[]).includes(value.code);
}
