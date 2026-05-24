/**
 * GET /api/customer/me
 *
 * Returns the authenticated customer's basic identity info.
 * Used by the customer layout shell to populate the user menu.
 *
 * Includes `hasPassword`, `hasEmail`, and `linkedAccounts` to support
 * the settings page conditional sections.
 */

import { sql } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';
import { listLinkedAccounts } from '@/lib/customer/linked-accounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
  allowUnverified: true,
  handler: async (ctx) => {
    const db = ctx.db;
    const customerId = ctx.customer.id;

    // Fetch password_hash + avatar_storage_key (not in ResolvedCustomer)
    const extraResult = await db.execute<{ password_hash: string | null; avatar_storage_key: string | null }>(
      sql`SELECT password_hash, avatar_storage_key FROM customers WHERE id = ${customerId} LIMIT 1`,
    );
    const extraRow = extraResult.rows[0] as { password_hash: string | null; avatar_storage_key: string | null } | undefined;
    const hasPassword = extraRow?.password_hash !== null && extraRow?.password_hash !== undefined;
    const avatarUrl = extraRow?.avatar_storage_key !== null && extraRow?.avatar_storage_key !== undefined
      ? `/api/customer/avatar/${extraRow.avatar_storage_key}`
      : null;

    // Fetch linked accounts
    const accounts = await listLinkedAccounts(db, customerId);
    const linkedAccounts = accounts.map((a) => ({
      provider: a.provider,
      email: a.providerEmail,
      displayName: a.providerDisplayName,
    }));

    return ctx.json({
      id: ctx.customer.id,
      email: ctx.customer.email,
      displayName: ctx.customer.displayName,
      avatarUrl,
      role: 'customer',
      kycLevel: ctx.customer.kycLevel,
      kycScore: ctx.customer.kycScore,
      status: ctx.customer.status,
      hasPassword,
      hasEmail: ctx.customer.email !== null,
      linkedAccounts,
    }, 200);
  },
});
