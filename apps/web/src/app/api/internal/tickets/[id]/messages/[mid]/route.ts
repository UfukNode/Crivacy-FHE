/**
 * PATCH /api/internal/tickets/[id]/messages/[mid], edit a firm
 * message that has not been seen yet. Author-only, same lock rules
 * as the customer path.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { handleEditFirmMessage } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
): Promise<NextResponse> {
  const { id, mid } = await params;
  return dashboardRoute({
    // Editing a reply is still a reply-level action (author-only
    // enforced inside handleEditFirmMessage), so gate on the same
    // `ticket.reply` permission the message-create endpoint uses.
    permission: 'ticket.reply',
    authConfig: getAuthConfig,
    sessionLookup: findSessionByJtiForMiddleware,
    firmUserLookup: findFirmUserByIdForMiddleware,
    firmLookup: findFirmByIdForMiddleware,
    handler: (ctx) => handleEditFirmMessage(ctx, id, mid),
  })(request);
}
