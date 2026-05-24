/**
 * POST /api/internal/admin/tickets/:id/participants/accept
 *
 * Accept a pending collaboration invite on a ticket. The caller can
 * only accept their own invite -- delegated accepting is disallowed,
 * so no `adminId` URL param exists. Expired invites return 410.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleAcceptParticipantInvite } from '@/server/handlers/tickets';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Intentionally NOT permission-gated, self-service accept on an
// invite that already targets the caller. The handler enforces
// "caller is the invitee" via the `ticket_participants` row lookup;
// RBAC adds nothing (the invite itself is the authorization signal).
export const POST = adminRoute({
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleAcceptParticipantInvite(ctx, id);
  },
});
