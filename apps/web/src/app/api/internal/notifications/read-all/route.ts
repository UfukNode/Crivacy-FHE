/**
 * POST /api/internal/notifications/read-all
 *
 * Mark every unread notification as read for the current firm user.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { markAllRead } from '@/lib/notification';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = dashboardRoute({
  permission: 'notifications.manage',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    await markAllRead(ctx.db, ctx.user.id, 'firm_user');
    return ctx.json({ success: true });
  },
});
