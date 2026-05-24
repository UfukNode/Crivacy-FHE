/**
 * PATCH /api/internal/notifications/[id]/read
 *
 * Mark a single notification as read. Ownership is enforced inside
 * `markRead`, passing the firm user's id + `firm_user` type means
 * only the owner's row is touched.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { markRead } from '@/lib/notification';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  return dashboardRoute({
    permission: 'notifications.manage',
    authConfig: getAuthConfig,
    sessionLookup: findSessionByJtiForMiddleware,
    firmUserLookup: findFirmUserByIdForMiddleware,
    firmLookup: findFirmByIdForMiddleware,
    handler: async (ctx) => {
      await markRead(ctx.db, id, ctx.user.id, 'firm_user');
      return ctx.json({ success: true });
    },
  })(request);
}
