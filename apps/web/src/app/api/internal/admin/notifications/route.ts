/**
 * GET /api/internal/admin/notifications, list notifications for the current admin.
 *
 * Supports cursor-based pagination via `cursor` (ISO 8601 timestamp) and
 * `limit` (default 20, max 50) query parameters.
 *
 * Requires a valid admin session.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { listNotifications } from '@/lib/notification';
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
    const url = new URL(ctx.request.url);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam !== null ? parseInt(limitParam, 10) : undefined;

    const result = await listNotifications(ctx.db, ctx.user.id, 'admin_user', {
      cursor,
      limit: limit !== undefined && !Number.isNaN(limit) ? limit : undefined,
    });

    return ctx.json({
      notifications: result.notifications,
      nextCursor: result.nextCursor,
    });
  },
});
