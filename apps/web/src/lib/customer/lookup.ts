/**
 * Shared customer session and customer lookup functions.
 *
 * These are used by all customer API routes via `customerRoute()` middleware.
 * Centralized here to avoid 30+ duplicate copies across route files.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import type { CustomerSessionRow, CustomerRow } from '@/server/middleware/customer-route';

/**
 * Look up a customer session by JWT ID (jti).
 * Returns the session row if found, null otherwise.
 */
export async function lookupCustomerSession(
  db: CrivacyDatabase,
  jti: string,
): Promise<CustomerSessionRow | null> {
  const result = await db.execute<{
    id: string;
    customer_id: string;
    revoked_at: string | null;
  }>(
    sql`SELECT id, customer_id, revoked_at::text
     FROM customer_sessions
     WHERE jwt_jti = ${jti}
     LIMIT 1`,
  );
  const row = result.rows[0] as {
    id: string;
    customer_id: string;
    revoked_at: string | null;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    revokedAt: row.revoked_at !== null ? new Date(row.revoked_at) : null,
  };
}

/**
 * Look up a customer by ID.
 * Returns the customer row if found, null otherwise.
 */
export async function lookupCustomer(
  db: CrivacyDatabase,
  customerId: string,
): Promise<CustomerRow | null> {
  const result = await db.execute<{
    id: string;
    email: string;
    display_name: string | null;
    status: string;
    kyc_level: string;
    kyc_score: number;
    locked_at: string | null;
    deleted_at: string | null;
    revoked_at: string | null;
    consecutive_kyc_declines: number;
    last_decline_at: string | null;
  }>(
    sql`SELECT id, email, display_name, status, kyc_level, kyc_score::int,
         locked_at::text, deleted_at::text, revoked_at::text,
         consecutive_kyc_declines::int, last_decline_at::text
     FROM customers
     WHERE id = ${customerId}
     LIMIT 1`,
  );
  const row = result.rows[0] as {
    id: string;
    email: string;
    display_name: string | null;
    status: string;
    kyc_level: string;
    kyc_score: number;
    locked_at: string | null;
    deleted_at: string | null;
    revoked_at: string | null;
    consecutive_kyc_declines: number;
    last_decline_at: string | null;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status as CustomerRow['status'],
    kycLevel: row.kyc_level,
    kycScore: row.kyc_score,
    lockedAt: row.locked_at !== null ? new Date(row.locked_at) : null,
    deletedAt: row.deleted_at !== null ? new Date(row.deleted_at) : null,
    revokedAt: row.revoked_at !== null ? new Date(row.revoked_at) : null,
    consecutiveKycDeclines: row.consecutive_kyc_declines,
    lastDeclineAt: row.last_decline_at !== null ? new Date(row.last_decline_at) : null,
  };
}
