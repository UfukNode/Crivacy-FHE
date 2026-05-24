/**
 * GET /api/customer/notifications, list notifications for the current customer.
 *
 * Supports cursor-based pagination via `cursor` (ISO 8601 timestamp) and
 * `limit` (default 20, max 50) query parameters.
 *
 * Requires a valid customer session.
 */


import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { listNotifications } from '@/lib/notification';
import { customerRoute } from '@/server/middleware/customer-route';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const GET = customerRoute({
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam !== null ? parseInt(limitParam, 10) : undefined;

    const result = await listNotifications(ctx.db, ctx.customer.id, 'customer', {
      cursor,
      limit: limit !== undefined && !Number.isNaN(limit) ? limit : undefined,
    });

    return ctx.json({
      notifications: result.notifications,
      nextCursor: result.nextCursor,
    });
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
