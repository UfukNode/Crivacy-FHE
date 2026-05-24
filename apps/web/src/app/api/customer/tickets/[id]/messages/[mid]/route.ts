/**
 * PATCH /api/customer/tickets/[id]/messages/[mid]
 *
 * Edit a customer-authored ticket message. The handler enforces
 * authorship, the seen-by-other lock, and the mention diff with
 * notification revocation for removed mentions.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleEditCustomerMessage } from '@/server/handlers/tickets';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
): Promise<NextResponse> {
  const { id, mid } = await params;
  return customerRoute({
    handler: (ctx) => handleEditCustomerMessage(ctx, id, mid),
    authConfig: getAuthConfig,
    sessionLookup: lookupCustomerSession,
    customerLookup: lookupCustomer,
    dbFactory: () => getDatabaseClient().db,
  })(request);
}
