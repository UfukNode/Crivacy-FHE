/**
 * GET   /api/internal/admin/tickets/:id, get ticket details + all messages
 * PATCH /api/internal/admin/tickets/:id, update ticket (status, priority, assignment)
 *
 * Requires a valid admin session with at least 'support' role.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleGetAdminTicket, handleUpdateAdminTicket } from '@/server/handlers/tickets';
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
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleGetAdminTicket(ctx, id);
  },
});

export const PATCH = adminRoute({
  // Status / priority / assignment mutations, `admin.ticket.assign`
  // covers the primary concern (reassignment). Support can already
  // assign per matrix.
  permission: 'admin.ticket.assign',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleUpdateAdminTicket(ctx, id);
  },
});
