/**
 * POST /api/internal/admin/tickets/:id/join-as-collab
 *
 * Superadmin-only silent-watch flow: join a ticket as an active
 * collaborator without sending a message and without becoming the
 * assignee. Idempotent on an existing active collab row; rejects
 * (409) if the caller is already the active assignee.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleSuperadminJoinAsCollab } from '@/server/handlers/tickets';
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
    return handleSuperadminJoinAsCollab(ctx, id);
  },
});
