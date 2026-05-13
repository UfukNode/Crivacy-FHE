/**
 * Firm-user + firm status invariant — limited cross-audience parity
 * extract (F-A2-H1-001 propagation, **partial**).
 *
 * Customer-side `lib/customer/status-check.ts::assertCustomerActive`
 * gates 4 invariants against a customer row: banned / suspended /
 * still-locked / soft-deleted. Firm + admin schema (`lib/db/schema/
 * users.ts`) currently expose only the **lock** state (`locked_at` +
 * `locked_until`); there is no `firm_users.status` column and no
 * `firm_users.deleted_at`. The granular ban / suspend semantic that
 * customer-side admin moderation provides has no firm-user analogue
 * today — see Findings F-A1-CROSS-PARITY-001 (P2, schema gap).
 *
 * Consequently this module **only** wraps the invariants that exist:
 *
 *   * `assertFirmUserActiveFromRow` — throws `AuthError 'account_locked'`
 *     when the lock window is open. **No banned/suspended branch** —
 *     writing one would be dead code, contradicting CLAUDE.md Kural 2.
 *   * `assertFirmActive` — throws `AuthError 'invalid_password'`
 *     (anti-enumeration shape) when the firm is missing or
 *     soft-deleted. Mirrors the inline check the handler used to do.
 *
 * Auto-unlock asymmetry: the customer helper performs a pre-verify
 * `UPDATE customers SET status='active', locked_at=NULL` once the
 * lockout window elapses. The firm + admin pipeline defers this to
 * the post-success path (`resetFailedLogin` repository fn). That is
 * intentional — F-A1-CROSS-PARITY-002 (P2, DOC-only). Multi-entry
 * surfaces (customer = password + OAuth + wallet) need the unlock
 * before the credential check; single-entry surfaces (firm + admin =
 * password + TOTP only) can defer because there is no other path
 * that would observe the stale `status='locked'` row.
 *
 * Lock failure surfaces as `AuthError` so callers in `lib/server/
 * handlers/dashboard-auth.ts` can keep their existing audit emission
 * shape (`firm_user.login.failed` action with `reason: 'account_locked'`
 * meta) — the helper throws, the caller catches `AuthError`, emits
 * audit, rethrows.
 *
 * @module
 */

import { AuthError } from '@/lib/auth/errors';

/**
 * Minimum row shape callers pass to {@link assertFirmUserActiveFromRow}.
 * Subset of the columns `dashboard-auth.ts::findUserByEmail` already
 * loads — no extra DB round-trip required at the callsite.
 */
export interface FirmUserLockStatusInput {
  readonly id: string;
  readonly lockedAt: Date | null;
  readonly lockedUntil: Date | null;
}

/**
 * Apply post-credential-proof lock invariant against an in-memory firm
 * user row. Caller MUST have completed password (and TOTP, when
 * enrolled) verification before calling — surfacing the lock state
 * pre-verify would turn the response into an enumeration oracle.
 *
 * Throws {@link AuthError} `'account_locked'` when the row's lock
 * window is open at `now`. Returns silently otherwise. Does not write
 * audit; the caller emits the `firm_user.login.failed` row with
 * `reason: 'account_locked'` so the actor + target shape stays in the
 * caller's existing audit-emit blocks.
 *
 * Auto-unlock is intentionally **not** performed here — see module
 * JSDoc + F-A1-CROSS-PARITY-002. The caller's success path eventually
 * runs `resetFailedLogin` which clears `locked_at` / `locked_until` /
 * `failed_login_count` in a single statement.
 */
export function assertFirmUserActiveFromRow(
  user: FirmUserLockStatusInput,
  now: Date,
): void {
  if (user.lockedAt !== null && user.lockedUntil !== null && user.lockedUntil > now) {
    throw new AuthError(
      'account_locked',
      'Account is temporarily locked. Please try again later.',
    );
  }
}

/**
 * Minimum row shape callers pass to {@link assertFirmActive}.
 * `null` is accepted for the "firm row missing entirely" branch — the
 * loaded user pointed at a `firm_id` that no longer resolves, which
 * collapses to the same anti-enumeration response.
 */
export interface FirmStatusInput {
  readonly id: string;
  readonly deletedAt: Date | null;
}

/**
 * Apply firm-level invariant: the firm tenant must exist and not be
 * soft-deleted. A firm-user with valid credentials whose firm has
 * been removed by an admin (`firms.deleted_at IS NOT NULL`) cannot
 * sign in — sessions for that firm should also have been revoked
 * during the admin's DELETE handler.
 *
 * Throws {@link AuthError} `'invalid_password'` (NOT `'firm_deleted'`)
 * to keep the response shape identical to the unknown-email + wrong-
 * password branches above the call. The caller can opt to emit a
 * separate audit row with `reason: 'firm_deleted'` if it wants the
 * forensic trail to distinguish the cases internally.
 */
export function assertFirmActive(firm: FirmStatusInput | null): void {
  if (firm === null || firm.deletedAt !== null) {
    throw new AuthError('invalid_password', 'Firm is not active.');
  }
}
