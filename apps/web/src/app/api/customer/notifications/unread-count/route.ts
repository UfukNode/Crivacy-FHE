/**
 * GET /api/customer/notifications/unread-count
 *
 * Returns the number of unread notifications for the current customer.
 * Used by the notification bell to display the badge count.
 *
 * Requires a valid customer session.
 */


import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { unreadCount } from '@/lib/notification';
import { customerRoute } from '@/server/middleware/customer-route';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const GET = customerRoute({
  handler: async (ctx) => {
    const count = await unreadCount(ctx.db, ctx.customer.id, 'customer');
    return ctx.json({ count });
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
