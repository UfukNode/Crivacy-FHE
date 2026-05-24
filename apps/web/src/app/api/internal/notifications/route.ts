/**
 * GET /api/internal/notifications, list notifications for the current firm user.
 *
 * Cursor-based pagination via `cursor` (ISO 8601) + `limit`
 * (default 20, max 50). Auth is the standard dashboard session;
 * `listNotifications` is the same lib the admin + customer portals
 * use, just with a different `UserType` discriminator.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { listNotifications } from '@/lib/notification';
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
    const url = new URL(ctx.request.url);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam !== null ? parseInt(limitParam, 10) : undefined;

    const result = await listNotifications(ctx.db, ctx.user.id, 'firm_user', {
      cursor,
      limit: limit !== undefined && !Number.isNaN(limit) ? limit : undefined,
    });

    return ctx.json({
      notifications: result.notifications,
      nextCursor: result.nextCursor,
    });
  },
});
