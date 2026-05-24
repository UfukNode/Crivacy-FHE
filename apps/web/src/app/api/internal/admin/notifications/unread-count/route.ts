/**
 * GET /api/internal/admin/notifications/unread-count
 *
 * Returns the number of unread notifications for the current admin.
 * Used by the notification bell to display the badge count.
 *
 * Requires a valid admin session.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { unreadCount } from '@/lib/notification';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  permission: 'notifications.read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const count = await unreadCount(ctx.db, ctx.user.id, 'admin_user');
    return ctx.json({ count });
  },
});
