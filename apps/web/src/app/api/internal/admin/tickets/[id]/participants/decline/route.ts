/**
 * POST /api/internal/admin/tickets/:id/participants/decline
 *
 * Decline a pending collaboration invite on a ticket. Only the
 * invitee (caller) can decline; delegated declines are disallowed.
 * Expired invites return 410.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleDeclineParticipantInvite } from '@/server/handlers/tickets';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Intentionally NOT permission-gated, same reasoning as accept:
// self-service on own invite, handler enforces caller-is-invitee.
export const POST = adminRoute({
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleDeclineParticipantInvite(ctx, id);
  },
});
