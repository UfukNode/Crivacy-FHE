/**
 * POST /api/internal/tickets/[id]/messages, reply to a firm ticket.
 *
 * Any active firm_user of the ticket's firm can reply (team inbox).
 */

import type { NextRequest, NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { handleAddFirmMessage } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return dashboardRoute({
    permission: 'ticket.reply',
    authConfig: getAuthConfig,
    sessionLookup: findSessionByJtiForMiddleware,
    firmUserLookup: findFirmUserByIdForMiddleware,
    firmLookup: findFirmByIdForMiddleware,
    handler: (ctx) => handleAddFirmMessage(ctx, id),
  })(request);
}
