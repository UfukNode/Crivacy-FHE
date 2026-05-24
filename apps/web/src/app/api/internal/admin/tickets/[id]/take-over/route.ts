/**
 * POST /api/internal/admin/tickets/:id/take-over
 *
 * Superadmin-only escape hatch. Reclaims an assigned ticket: the
 * previous assignee is either demoted to an active collaborator
 * (default) or marked `removed`, and the superadmin is installed as
 * the new assignee.
 *
 * Rejects with 409 if the caller is already the assignee or the
 * ticket is in a terminal state.
 */

import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { handleTakeOverTicket } from '@/server/handlers/tickets';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = adminRoute({
  permission: 'admin.ticket.take_over',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const { rest, gate } = await parseDestructiveEnvelope(ctx.request);

    // BUG #58: password + TOTP reauth before take-over (Superadmin
    // escape hatch; reclaims an assigned ticket and demotes the
    // previous assignee, highest-power admin op).
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'admin', id: ctx.user.id },
      envelope: gate,
      now: ctx.now,
      authConfig: getAuthConfig(),
    });
    if (reauth.status === 'denied') {
      return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
    }

    return handleTakeOverTicket(ctx, id, rest);
  },
});
