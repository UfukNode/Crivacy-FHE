/**
 * PATCH /api/internal/admin/tickets/:id/messages/:mid, edit admin message.
 *
 * Requires a valid admin session. The handler enforces authorship
 * (caller === message sender), the seen-by-other lock, the mention
 * diff with notification revocation for removed mentions, and writes
 * a `ticket.message_edited` audit entry carrying the before/after body.
 */

import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { handleEditAdminMessage } from '@/server/handlers/tickets';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = adminRoute({
  permission: 'ticket.reply',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string; mid: string }> }) => {
    const { id, mid } = await params;
    const { rest, gate } = await parseDestructiveEnvelope(ctx.request);

    // BUG #58: password + TOTP reauth before message edit
    // (evidence-tampering vector, stolen-session attacker rewrites
    // ticket history, timestamps stay identical, audience can't
    // tell from the rendered thread that the body changed).
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

    return handleEditAdminMessage(ctx, id, mid, rest);
  },
});
