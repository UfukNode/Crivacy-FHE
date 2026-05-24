/**
 * POST /api/internal/admin/tickets/:id/messages, add admin message to ticket
 *
 * Requires a valid admin session with at least 'support' role.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleAddAdminMessage } from '@/server/handlers/tickets';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = adminRoute({
  // Shared `ticket.reply` code, admin replying is the same action as
  // firm_user replying. Internal-note flag (if the body sets it)
  // additionally requires `admin.ticket.add_internal_note` inside
  // the handler's branch on message type.
  permission: 'ticket.reply',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleAddAdminMessage(ctx, id);
  },
});
