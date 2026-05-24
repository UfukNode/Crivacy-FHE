/**
 * PATCH /api/customer/notifications/[id]/read
 *
 * Mark a single notification as read for the current customer.
 * Verifies ownership before updating.
 *
 * Requires a valid customer session.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { markRead } from '@/lib/notification';
import { customerRoute } from '@/server/middleware/customer-route';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return customerRoute({
    handler: async (ctx) => {
      await markRead(ctx.db, id, ctx.customer.id, 'customer');
      return ctx.json({ success: true });
    },
    authConfig: getAuthConfig,
    sessionLookup: lookupCustomerSession,
    customerLookup: lookupCustomer,
    dbFactory: () => getDatabaseClient().db,
  })(request);
}
