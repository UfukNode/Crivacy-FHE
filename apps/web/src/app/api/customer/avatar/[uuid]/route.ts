/**
 * GET /api/customer/avatar/[uuid]
 *
 * Serve the avatar image for the given storage key. Returns the WebP file
 * with immutable cache headers. Requires a valid customer session.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleServeAvatar } from '@/server/handlers/customer-profile';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ uuid: string }> },
): Promise<NextResponse> {
  const { uuid } = await params;
  return customerRoute({
    handler: (ctx) => handleServeAvatar(ctx, uuid),
    authConfig: getAuthConfig,
    sessionLookup: lookupCustomerSession,
    customerLookup: lookupCustomer,
    dbFactory: () => getDatabaseClient().db,
  })(request);
}
