/**
 * POST /api/internal/admin/tickets/:id/participants
 *
 * Invite a peer admin or direct-add a lower-tier admin as a
 * collaborator. The handler picks between `pending` (requires
 * accept/decline) and `active` (direct add) based on the hierarchy
 * between caller and target.
 *
 * Requires an active admin session. The assignee or a superadmin may
 * invite; everyone else gets a 403 from the handler.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleInviteParticipant } from '@/server/handlers/tickets';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = adminRoute({
  permission: 'admin.ticket.participants_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleInviteParticipant(ctx, id);
  },
});
