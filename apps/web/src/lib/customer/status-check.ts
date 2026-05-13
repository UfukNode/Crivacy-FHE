/**
 * Customer status invariant — single gate for "is this account
 * permitted to sign in right now?". Both the password-login pipeline
 * (`loginCustomer`) and the OAuth/SSO pipeline (`loginViaOAuth`)
 * route through here so a banned/suspended/locked customer cannot
 * sneak in via the IdP path while being blocked on email+password.
 *
 * Surfacing precise codes (account_banned / account_suspended /
 * account_locked) is intentional and safe at every callsite: each
 * caller has already established the caller owns the credential
 * (password verified, or Google's `email_verified` claim trusted
 * after IdP trust). Pre-credential-proof callsites must NOT use
 * these helpers — surfacing status before the password-or-IdP step
 * turns the response into an enumeration oracle (Page 1 audit
 * lesson).
 *
 * The locked branch double-buttons: it throws when still inside the
 * lockout window AND auto-unlocks once the window has elapsed
 * (clearing `failed_login_attempts`, restoring `status` to `active`
 * or `pending_verification` based on `email_verified_at`). The
 * UPDATE is fire-and-forget on the call path — the surrounding
 * pipeline does not need to re-read the row because the rest of the
 * flow only consumes fields that are not touched by the unlock.
 *
 * Email-verified enforcement is intentionally NOT here. That is a
 * password-flow concept — OAuth callbacks short-circuit on the
 * IdP's verified-email claim before reaching this point, so demanding
 * the local `email_verified_at !== null` would lock out customers
 * whose only credential is Google. Password-login carries its own
 * email_verified_at check inline; OAuth-login does not.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';

import type { CustomerAuthConfig } from './config';
import { CustomerError } from './errors';

/**
 * Minimum row shape callers pass to {@link assertCustomerActiveFromRow}.
 * Subset of the columns returned by the password-login query so
 * `loginCustomer` can pass its already-loaded row without a second DB
 * round-trip.
 */
export interface CustomerStatusInput {
  readonly id: string;
  readonly status: string;
  readonly emailVerifiedAt: string | null;
  readonly lockedAt: string | null;
}

/**
 * Apply post-credential-proof status semantics against an in-memory
 * row. Caller is responsible for verifying the row exists and is not
 * soft-deleted before calling — this helper trusts the row.
 *
 * Throws {@link CustomerError} on banned / suspended / still-locked.
 * Performs an idempotent auto-unlock UPDATE when the lock window has
 * elapsed; the caller's subsequent `failed_login_attempts = 0` reset
 * (if any) is harmless because both writes converge on zero.
 */
export async function assertCustomerActiveFromRow(
  db: CrivacyDatabase,
  row: CustomerStatusInput,
  customerConfig: CustomerAuthConfig,
  now: Date,
): Promise<void> {
  if (row.status === 'banned' || row.status === 'suspended') {
    const code = row.status === 'suspended' ? 'account_suspended' : 'account_banned';
    const message = row.status === 'suspended'
      ? 'Account is suspended. Contact support to review the restriction.'
      : 'Account has been banned. Please contact support.';
    throw new CustomerError(code, message);
  }

  if (row.status === 'locked' && row.lockedAt !== null) {
    const lockExpiry = new Date(
      new Date(row.lockedAt).getTime() + customerConfig.lockDurationMinutes * 60_000,
    );
    if (now < lockExpiry) {
      throw new CustomerError(
        'account_locked',
        'Account is temporarily locked due to too many failed attempts. Please try again later.',
      );
    }
    const newStatus = row.emailVerifiedAt !== null ? 'active' : 'pending_verification';
    await db.execute(
      sql`UPDATE customers
       SET status = ${newStatus},
           locked_at = NULL,
           lock_reason = NULL,
           failed_login_attempts = 0,
           updated_at = ${now.toISOString()}
       WHERE id = ${row.id}`,
    );
  }
}

/**
 * Convenience overload that loads the row itself. Used by code paths
 * that don't already have the customer row in memory — primarily
 * `loginViaOAuth` (linked-account branch) and the auto-link path
 * before it commits a `customer_linked_accounts` insert.
 *
 * Soft-deleted or missing rows collapse to `invalid_credentials` —
 * same shape as the unknown-email branch in `loginCustomer` so a race
 * between an admin soft-delete and an in-flight OAuth callback cannot
 * be distinguished from a routine credential failure.
 */
export async function assertCustomerActive(
  db: CrivacyDatabase,
  customerId: string,
  customerConfig: CustomerAuthConfig,
  now: Date,
): Promise<CustomerStatusInput> {
  const result = await db.execute<{
    id: string;
    status: string;
    email_verified_at: string | null;
    locked_at: string | null;
    deleted_at: string | null;
  }>(
    sql`SELECT id,
              status,
              email_verified_at::text,
              locked_at::text,
              deleted_at::text
       FROM customers
       WHERE id = ${customerId}
       LIMIT 1`,
  );
  const dbRow = result.rows[0] as
    | {
        id: string;
        status: string;
        email_verified_at: string | null;
        locked_at: string | null;
        deleted_at: string | null;
      }
    | undefined;

  if (dbRow === undefined || dbRow.deleted_at !== null) {
    throw new CustomerError('invalid_credentials', 'Invalid email or password.');
  }

  const row: CustomerStatusInput = {
    id: dbRow.id,
    status: dbRow.status,
    emailVerifiedAt: dbRow.email_verified_at,
    lockedAt: dbRow.locked_at,
  };
  await assertCustomerActiveFromRow(db, row, customerConfig, now);
  return row;
}
