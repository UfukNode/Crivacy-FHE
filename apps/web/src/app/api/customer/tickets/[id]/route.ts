/**
 * GET /api/customer/tickets/[id]
 *
 * Returns details for a specific ticket owned by the authenticated
 * customer. Dynamic route, the `[id]` segment is extracted from the URL
 * params and passed to the handler via closure.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleGetCustomerTicket } from '@/server/handlers/tickets';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return customerRoute({
    handler: (ctx) => handleGetCustomerTicket(ctx, id),
    authConfig: getAuthConfig,
    sessionLookup: lookupCustomerSession,
    customerLookup: lookupCustomer,
    dbFactory: () => getDatabaseClient().db,
  })(request);
}
