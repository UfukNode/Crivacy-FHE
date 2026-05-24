/**
 * POST /api/customer/kyc/session/[id]/resume
 *
 * Resume or check the status of an existing KYC session. If the session
 * is still in progress, this endpoint polls Didit for a decision update
 * and returns the current status along with a redirect URL to continue
 * verification.
 *
 * Dynamic route, the `[id]` segment is extracted from the URL params
 * and passed to the handler via closure.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleResumeSession } from '@/server/handlers/customer-kyc';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return customerRoute({
    handler: (ctx) => handleResumeSession(ctx, id),
    authConfig: getAuthConfig,
    sessionLookup: lookupCustomerSession,
    customerLookup: lookupCustomer,
    dbFactory: () => getDatabaseClient().db,
  })(request);
}
