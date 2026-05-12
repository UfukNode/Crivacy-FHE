/**
 * Admin-user status invariant — limited cross-audience parity extract
 * (F-A2-H1-001 propagation, **partial**).
 *
 * Mirror of `lib/firm/status-check.ts` for the admin audience. Same
 * scope rationale: `admin_users` schema (`lib/db/schema/users.ts`)
 * has only `locked_at` + `locked_until` — no `status` column, no
 * `deleted_at`. Customer-pattern banned / suspended / soft-deleted
 * branches have no admin-side analogue today (F-A1-CROSS-PARITY-001
 * P2 schema gap).
 *
 * Auto-unlock pattern asymmetry: same as firm — admin pipeline defers
 * to post-success `resetFailedLogin` (in
 * `repositories/admin.ts::resetAdminFailedLogin`). Single-entry-surface
 * audience, no race against an alternate auth method that would
 * observe a stale `lockedAt != NULL` (F-A1-CROSS-PARITY-002 P2 DOC).
 *
 * @module
 */

import { AuthError } from '@/lib/auth/errors';

/**
 * Minimum row shape callers pass to {@link assertAdminUserActiveFromRow}.
 * Subset of the columns `admin-auth.ts::findAdminUserByEmail` loads.
 */
export interface AdminUserLockStatusInput {
  readonly id: string;
  readonly lockedAt: Date | null;
  readonly lockedUntil: Date | null;
}

/**
 * Apply post-credential-proof lock invariant against an in-memory
 * admin user row. Caller MUST have verified password (and TOTP, when
 * enrolled) before calling — pre-verify lock surface would leak the
 * email's existence to a credential-stuffer.
 *
 * Throws {@link AuthError} `'account_locked'` when the row's lock
 * window is open at `now`. Returns silently otherwise. Does not write
 * audit; the caller emits `admin_user.login.failed` with
 * `reason: 'account_locked'`.
 *
 * Auto-unlock is intentionally not performed here — see module JSDoc
 * + F-A1-CROSS-PARITY-002. Successful login eventually triggers
 * `resetAdminFailedLogin` which clears the lock columns atomically.
 */
export function assertAdminUserActiveFromRow(
  user: AdminUserLockStatusInput,
  now: Date,
): void {
  if (user.lockedAt !== null && user.lockedUntil !== null && user.lockedUntil > now) {
    throw new AuthError(
      'account_locked',
      'Account is temporarily locked. Please try again later.',
    );
  }
}
