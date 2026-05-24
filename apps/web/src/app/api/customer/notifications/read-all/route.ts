/**
 * POST /api/customer/notifications/read-all
 *
 * Mark all unread notifications as read for the current customer.
 *
 * Requires a valid customer session.
 */


import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { markAllRead } from '@/lib/notification';
import { customerRoute } from '@/server/middleware/customer-route';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST = customerRoute({
  handler: async (ctx) => {
    await markAllRead(ctx.db, ctx.customer.id, 'customer');
    return ctx.json({ success: true });
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
