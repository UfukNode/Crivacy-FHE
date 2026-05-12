/**
 * Admin-layer error taxonomy.
 *
 * Thrown by helpers that back the `/admin` API surface — specifically
 * the firm CRUD repository functions — when a user-visible failure
 * should turn into a typed HTTP response instead of a generic 500.
 *
 * Follows the `AuthError` / `RbacError` pattern: a single concrete
 * class carrying a machine-readable `code` that the error-mapper
 * translates to the matching status / message in the public API.
 *
 * The reason we don't collapse this into `AuthError`: admin-side
 * business rules (slug collisions, firm-lifecycle guards) aren't an
 * authentication concern. Keeping them separate prevents downstream
 * branching logic from having to check whether "auth" means "login
 * failed" or "you can't restore this firm".
 */

export type AdminErrorCode =
  | 'firm_slug_taken'
  | 'firm_not_found'
  | 'firm_already_active';

export class AdminError extends Error {
  readonly code: AdminErrorCode;

  constructor(code: AdminErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AdminError';
    this.code = code;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, AdminError);
    }
  }
}

export function isAdminError(value: unknown): value is AdminError {
  return value instanceof AdminError;
}

/**
 * Postgres unique-violation SQLSTATE. Repository functions catch this
 * specifically on the `firms_slug_key` index to convert into a typed
 * {@link AdminError} with `firm_slug_taken` — any other 23505 should
 * keep bubbling because it signals a different bug.
 */
export const PG_UNIQUE_VIOLATION = '23505';
