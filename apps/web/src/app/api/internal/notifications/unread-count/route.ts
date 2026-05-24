/**
 * GET /api/internal/notifications/unread-count
 *
 * Returns the number of unread notifications for the current firm
 * user. Drives the badge count on the dashboard notification bell.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { unreadCount } from '@/lib/notification';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = dashboardRoute({
  permission: 'notifications.read',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const count = await unreadCount(ctx.db, ctx.user.id, 'firm_user');
    return ctx.json({ count });
  },
});
