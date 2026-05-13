/**
 * Email verification logic — 6-digit code based.
 *
 * The customer submits their email + 6-digit code. We look up the latest
 * non-invalidated, non-used code for that customer, verify it matches,
 * and activate the account.
 *
 * Wrong attempts are counted per code row. After MAX_CODE_ATTEMPTS wrong
 * guesses the code is invalidated and the customer must request a new one.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { constantTimeHashEqual, hashSubmittedCode } from './verification-code';

export type VerifyEmailResult =
  | { readonly status: 'verified'; readonly customerId: string }
  | { readonly status: 'expired' }
  | { readonly status: 'invalid' }
  | { readonly status: 'max_attempts' };

/**
 * Verify a customer's email using a 6-digit code.
 *
 * @param email - The customer's email address (used to look up customer).
 * @param rawCode - The 6-digit code entered by the user.
 * @param maxAttempts - Maximum wrong attempts per code (default 5).
 */
export async function verifyEmail(
  db: CrivacyDatabase,
  email: string,
  rawCode: string,
  maxAttempts: number = 5,
  clock: () => Date = () => new Date(),
): Promise<VerifyEmailResult> {
  const now = clock();
  const emailLower = email.toLowerCase().trim();
  const codeHash = hashSubmittedCode(rawCode);

  // Find customer by email
  const customerResult = await db.execute<{
    id: string;
    email_verified_at: string | null;
    status: string;
    deleted_at: string | null;
  }>(
    sql`SELECT id, email_verified_at::text, status, deleted_at::text
     FROM customers
     WHERE lower(email) = ${emailLower} AND deleted_at IS NULL
     LIMIT 1`,
  );
  const customer = customerResult.rows[0] as {
    id: string;
    email_verified_at: string | null;
    status: string;
    deleted_at: string | null;
  } | undefined;

  if (!customer) {
    return { status: 'invalid' };
  }

  // Already verified — collapse into `invalid`. Previously this
  // returned a distinct `already_verified` status which, combined
  // with the 200 HTTP status, told an attacker submitting a random
  // code that the email is registered AND verified in a single
  // request. The stale-link UX ("you're already verified, go log in")
  // is lost here; legit repeat-clickers will see `invalid` and can
  // proceed to the login page themselves.
  if (customer.email_verified_at !== null) {
    return { status: 'invalid' };
  }

  // Find the latest non-invalidated, non-used verification token for this customer
  const tokenResult = await db.execute<{
    id: string;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
    attempts: number;
    invalidated_at: string | null;
  }>(
    sql`SELECT id, token_hash, expires_at::text, used_at::text, attempts::int, invalidated_at::text
     FROM email_verification_tokens
     WHERE customer_id = ${customer.id}
       AND used_at IS NULL
       AND invalidated_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  const tokenRow = tokenResult.rows[0] as {
    id: string;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
    attempts: number;
    invalidated_at: string | null;
  } | undefined;

  // Collapse "no pending token" into `invalid` — a distinct status
  // would enumerate existing customers from unregistered addresses.
  if (!tokenRow) {
    return { status: 'invalid' };
  }

  // Check expiry
  if (new Date(tokenRow.expires_at) < now) {
    return { status: 'expired' };
  }

  // Check code match — constant-time compare (see
  // `constantTimeHashEqual` docstring).
  if (!constantTimeHashEqual(tokenRow.token_hash, codeHash)) {
    // Increment attempt count
    const newAttempts = tokenRow.attempts + 1;
    if (newAttempts >= maxAttempts) {
      // Invalidate the code
      await db.execute(
        sql`UPDATE email_verification_tokens
         SET attempts = ${newAttempts}, invalidated_at = ${now.toISOString()}
         WHERE id = ${tokenRow.id}`,
      );
      return { status: 'max_attempts' };
    }
    await db.execute(
      sql`UPDATE email_verification_tokens SET attempts = ${newAttempts} WHERE id = ${tokenRow.id}`,
    );
    return { status: 'invalid' };
  }

  // Code matches — mark as used
  await db.execute(
    sql`UPDATE email_verification_tokens SET used_at = ${now.toISOString()} WHERE id = ${tokenRow.id}`,
  );

  // status precondition prevents banned-bypass via stale pending tokens (do not remove)
  const result = await db.execute(
    sql`UPDATE customers
     SET email_verified_at = ${now.toISOString()},
         status = 'active',
         kyc_level = 'kyc_1',
         kyc_score = 100,
         updated_at = ${now.toISOString()}
     WHERE id = ${customer.id}
       AND email_verified_at IS NULL
       AND status = 'pending_verification'`,
  );

  if ((result.rowCount ?? 0) === 0) {
    return { status: 'invalid' };
  }

  return { status: 'verified', customerId: customer.id };
}
