/**
 * DELETE /api/internal/admin/tickets/:id/participants/:adminId
 *
 * Remove a participant from a ticket. Covers:
 *   * Self-leave -- the caller leaves voluntarily.
 *   * Remove-other -- the assignee or a superadmin kicks a collaborator.
 *
 * The active assignee cannot be removed via this endpoint; use
 * reassign (hand-off) or take-over (superadmin escape hatch).
 */

import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { handleRemoveParticipant } from '@/server/handlers/tickets';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = adminRoute({
  permission: 'admin.ticket.participants_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (
    ctx,
    { params }: { params: Promise<{ id: string; adminId: string }> },
  ) => {
    const { id, adminId } = await params;
    const { rest, gate } = await parseDestructiveEnvelope(ctx.request);

    // BUG #58: password + TOTP reauth before participant removal
    // (lone-admin attack, stolen-session attacker kicks every
    // other collaborator, isolates the ticket, no oversight).
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

    return handleRemoveParticipant(ctx, id, adminId, rest);
  },
});
