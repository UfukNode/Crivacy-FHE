/**
 * Customer linked accounts — DB operations for OAuth/wallet accounts.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinkedAccountRow {
  readonly id: string;
  readonly customerId: string;
  readonly provider: string;
  readonly providerAccountId: string;
  readonly providerEmail: string | null;
  readonly providerDisplayName: string | null;
}

export interface CustomerBasicRow {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly status: string;
  readonly emailVerifiedAt: string | null;
  readonly deletedAt: string | null;
  readonly passwordHash: string | null;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Find a linked account by provider + provider account ID.
 * Returns the linked account row or null.
 */
export async function findLinkedAccount(
  db: CrivacyDatabase,
  provider: string,
  providerAccountId: string,
): Promise<LinkedAccountRow | null> {
  const result = await db.execute<{
    id: string;
    customer_id: string;
    provider: string;
    provider_account_id: string;
    provider_email: string | null;
    provider_display_name: string | null;
  }>(
    sql`SELECT id, customer_id, provider, provider_account_id, provider_email, provider_display_name
     FROM customer_linked_accounts
     WHERE provider = ${provider} AND provider_account_id = ${providerAccountId}
     LIMIT 1`,
  );

  const row = result.rows[0] as typeof result.rows[number] | undefined;
  if (!row) return null;

  return {
    id: row.id,
    customerId: row.customer_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    providerEmail: row.provider_email,
    providerDisplayName: row.provider_display_name,
  };
}

/**
 * Find a customer by email (case-insensitive).
 * Returns basic customer info or null.
 */
export async function findCustomerByEmail(
  db: CrivacyDatabase,
  email: string,
): Promise<CustomerBasicRow | null> {
  const emailLower = email.toLowerCase().trim();
  const result = await db.execute<{
    id: string;
    email: string;
    display_name: string | null;
    status: string;
    email_verified_at: string | null;
    deleted_at: string | null;
    password_hash: string;
  }>(
    sql`SELECT id, email, display_name, status, email_verified_at::text, deleted_at::text, password_hash
     FROM customers
     WHERE lower(email) = ${emailLower} AND deleted_at IS NULL
     LIMIT 1`,
  );

  const row = result.rows[0] as typeof result.rows[number] | undefined;
  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    emailVerifiedAt: row.email_verified_at,
    deletedAt: row.deleted_at,
    passwordHash: row.password_hash,
  };
}

// ---------------------------------------------------------------------------
// Create / Link
// ---------------------------------------------------------------------------

/**
 * Create a new linked account for an existing customer.
 *
 * F-A2-AG-001 (Page 2 closure): the previous behaviour was
 * `ON CONFLICT (customer_id, provider) DO UPDATE SET
 * provider_account_id = EXCLUDED.provider_account_id`. That silently
 * REPLACED the existing provider sub on a re-link — an attacker who
 * controlled a different Google account with the same verified
 * email could land on the auto-link path after a victim's session
 * was thieved and overwrite the legitimate sub with their own,
 * giving the attacker a permanent OAuth login backdoor.
 *
 * Now: `ON CONFLICT DO NOTHING` (covers both `(provider,
 * provider_account_id)` and `(customer_id, provider)` unique
 * indexes) + RETURNING. Callers branch on `null` — the conflict
 * fired, no row was written, surface `provider_already_linked` 409
 * (or the audience-specific redirect equivalent in callback paths)
 * so the user manually unlinks the existing credential first via
 * `/settings/security`. Defence pattern matches GitHub / Auth0 /
 * Stripe linked-account semantics.
 */
export async function createLinkedAccount(
  db: CrivacyDatabase,
  customerId: string,
  provider: string,
  providerAccountId: string,
  providerEmail: string | null,
  providerDisplayName: string | null,
): Promise<string | null> {
  const result = await db.execute<{ id: string }>(
    sql`INSERT INTO customer_linked_accounts (customer_id, provider, provider_account_id, provider_email, provider_display_name, created_at)
     VALUES (${customerId}, ${provider}, ${providerAccountId}, ${providerEmail}, ${providerDisplayName}, NOW())
     ON CONFLICT DO NOTHING
     RETURNING id`,
  );

  const row = result.rows[0] as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * List all linked accounts for a customer.
 */
export async function listLinkedAccounts(
  db: CrivacyDatabase,
  customerId: string,
): Promise<LinkedAccountRow[]> {
  const result = await db.execute<{
    id: string;
    customer_id: string;
    provider: string;
    provider_account_id: string;
    provider_email: string | null;
    provider_display_name: string | null;
  }>(
    sql`SELECT id, customer_id, provider, provider_account_id, provider_email, provider_display_name
     FROM customer_linked_accounts
     WHERE customer_id = ${customerId}
     ORDER BY created_at ASC`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    providerEmail: row.provider_email,
    providerDisplayName: row.provider_display_name,
  }));
}

/**
 * Remove a linked account.
 */
export async function removeLinkedAccount(
  db: CrivacyDatabase,
  customerId: string,
  provider: string,
): Promise<boolean> {
  const result = await db.execute(
    sql`DELETE FROM customer_linked_accounts
     WHERE customer_id = ${customerId} AND provider = ${provider}`,
  );
  return (result.rowCount ?? 0) > 0;
}
