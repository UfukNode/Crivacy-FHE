/**
 * GET /api/internal/tickets/[id], single-ticket detail for firm users.
 *
 * Team-scoped: any active firm_user of the ticket's firm may read it
 * (shared inbox). Returns ticket fields + messages (public only,
 * internal notes never leak to the firm side).
 */

import type { NextRequest, NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { handleGetFirmTicket } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return dashboardRoute({
    // Shared inbox read: `ticket.read.firm` (Admin+) required.
    // Member/Viewer who created a ticket see it via `ticket.read.own`
    // on the `/api/customer/tickets/:id` surface, they do not hit
    // the firm inbox detail endpoint at all.
    permission: 'ticket.read.firm',
    authConfig: getAuthConfig,
    sessionLookup: findSessionByJtiForMiddleware,
    firmUserLookup: findFirmUserByIdForMiddleware,
    firmLookup: findFirmByIdForMiddleware,
    handler: (ctx) => handleGetFirmTicket(ctx, id),
  })(request);
}
