/**
 * POST /api/internal/admin/notifications/read-all
 *
 * Mark all unread notifications as read for the current admin.
 *
 * Requires a valid admin session.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { markAllRead } from '@/lib/notification';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = adminRoute({
  permission: 'notifications.manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    await markAllRead(ctx.db, ctx.user.id, 'admin_user');
    return ctx.json({ success: true });
  },
});
