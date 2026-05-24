/**
 * PATCH /api/internal/admin/notifications/[id]/read
 *
 * Mark a single notification as read for the current admin.
 * Verifies ownership before updating.
 *
 * Requires a valid admin session.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { markRead } from '@/lib/notification';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  return adminRoute({
    permission: 'notifications.manage',
    authConfig: getAuthConfig,
    sessionLookup: findAdminSessionByJtiForMiddleware,
    adminUserLookup: findAdminUserByIdForMiddleware,
    handler: async (ctx) => {
      await markRead(ctx.db, id, ctx.user.id, 'admin_user');
      return ctx.json({ success: true });
    },
  })(request, context);
}
