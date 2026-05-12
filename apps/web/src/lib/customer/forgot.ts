/**
 * Forgot password — generate 6-digit reset code.
 *
 * Always returns void (200 OK) regardless of whether the email exists.
 * This prevents email enumeration attacks.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { issueShortLivedToken } from '@/lib/auth/short-lived-tokens';
import { CUSTOMER_PASSWORD_RESET_TABLE } from '@/lib/auth/verify-email-code';
import { hashSubmittedCode } from './verification-code';

export interface ForgotPasswordResult {
  /** Null if email not found or customer is banned (silent). */
  readonly resetCode: string | null;
  readonly customerId: string | null;
  readonly codeHash: string | null;
  /**
   * Customer's stored display name, when available. Returned so the
   * email template can greet with the real name ("Hi John Doe,")
   * instead of falling back to the raw email local-part ("Hi john.doe,").
   * Null for customers who never set one.
   */
  readonly customerDisplayName: string | null;
}

/**
 * Generate a password reset 6-digit code for the given email.
 *
 * Returns null if the customer doesn't exist, is banned, or is deleted.
 * The caller always responds with 200 to prevent enumeration.
 */
export async function requestPasswordReset(
  db: CrivacyDatabase,
  email: string,
  resetTtlSeconds: number,
  ip: string | null,
  clock: () => Date = () => new Date(),
): Promise<ForgotPasswordResult> {
  const now = clock();
  const emailLower = email.toLowerCase().trim();

  // Find customer
  const customerResult = await db.execute<{
    id: string;
    status: string;
    deleted_at: string | null;
    display_name: string | null;
  }>(
    sql`SELECT id, status, deleted_at::text, display_name FROM customers WHERE lower(email) = ${emailLower} LIMIT 1`,
  );
  const customer = customerResult.rows[0] as
    | { id: string; status: string; deleted_at: string | null; display_name: string | null }
    | undefined;

  if (!customer || customer.deleted_at !== null || customer.status === 'banned') {
    return { resetCode: null, customerId: null, codeHash: null, customerDisplayName: null };
  }

  // Issue a fresh reset code through the shared primitive. The helper
  // atomically invalidates any pending unused row for this customer
  // before inserting the new one + writes `ip_address` because the
  // customer reset table opts into the audit breadcrumb.
  const issued = await issueShortLivedToken({
    db,
    table: CUSTOMER_PASSWORD_RESET_TABLE,
    subjectId: customer.id,
    ttlSeconds: resetTtlSeconds,
    ...(ip !== null ? { ipAddress: ip } : {}),
    now,
  });

  return {
    resetCode: issued.rawCode,
    customerId: customer.id,
    codeHash: hashSubmittedCode(issued.rawCode),
    customerDisplayName: customer.display_name,
  };
}
