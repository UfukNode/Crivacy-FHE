/**
 * POST /api/customer/tickets/[id]/messages/[mid]/attachments
 *
 * Upload an image attachment to a ticket message. Dynamic route —
 * the `[id]` and `[mid]` segments are extracted from the URL params.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleUploadAttachment } from '@/server/handlers/ticket-attachments';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
): Promise<NextResponse> {
  const { id, mid } = await params;
  return customerRoute({
    handler: async (ctx) => {
      // Per-IP cap, attachment upload is 5 MiB + sharp CPU,
      // equivalent cost to avatar upload. Stolen session without
      // this cap = disk fill / CPU starvation vector.
      const limited = await maybeRateLimitResponse(
        ctx.db,
        'customer_ticket_attachment_upload',
        ctx.ip,
        ctx.now,
      );
      if (limited) return limited;
      return handleUploadAttachment(ctx, id, mid);
    },
    authConfig: getAuthConfig,
    sessionLookup: lookupCustomerSession,
    customerLookup: lookupCustomer,
    dbFactory: () => getDatabaseClient().db,
  })(request);
}
