/**
 * GET /api/internal/admin/tickets, list all tickets (admin view)
 *
 * Requires a valid admin session with at least 'support' role.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleListAdminTickets } from '@/server/handlers/tickets';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  permission: 'admin.ticket.read_all',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    return handleListAdminTickets(ctx);
  },
});
