/**
 * GET /api/customer/sessions
 *
 * List the customer's active sessions. A session is considered active if it
 * has no `revoked_at` timestamp and its `expires_at` has not passed. The
 * current session (matched by JWT `jti`) is flagged with `isCurrent: true`.
 *
 * Sorted by `last_active_at DESC`, most recently active session first.
 */

import { sql } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const GET = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
  handler: async (ctx) => {
    const db = ctx.db;
    const now = ctx.now;
    const customerId = ctx.customer.id;
    const currentSessionId = ctx.session.sessionId;

    // Fetch active (non-revoked, non-expired) sessions for this customer
    const result = await db.execute<{
      id: string;
      device_name: string | null;
      city: string | null;
      ip: string | null;
      last_active_at: string;
    }>(
      sql`SELECT id, device_name, city, ip, last_active_at::text
       FROM customer_sessions
       WHERE customer_id = ${customerId}
         AND revoked_at IS NULL
         AND expires_at > ${now.toISOString()}
       ORDER BY last_active_at DESC`,
    );

    const sessions = (result.rows as Array<{
      id: string;
      device_name: string | null;
      city: string | null;
      ip: string | null;
      last_active_at: string;
    }>).map((row) => ({
      id: row.id,
      deviceName: row.device_name,
      city: row.city,
      ip: row.ip,
      lastActiveAt: row.last_active_at,
      isCurrent: row.id === currentSessionId,
    }));

    return ctx.json({ sessions });
  },
});
