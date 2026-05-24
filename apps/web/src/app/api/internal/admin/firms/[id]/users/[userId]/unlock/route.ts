/**
 * POST /api/internal/admin/firms/:id/users/:userId/unlock
 *
 * Admin support action, clear a firm_user's lock so they can log in
 * again. Useful when the brute-force counter locked a legitimate
 * teammate out after a password-manager hiccup or similar.
 *
 * Audit-heavy: every unlock logs `firm.user_removed` (re-used as the
 * generic "admin touched this user" action) with `adminUnlock: true`
 * in the meta so the trail separates admin overrides from
 * teammate-initiated events.
 */

import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { handleAdminUnlockFirmUser } from '@/server/handlers';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = adminRoute({
  // Matrix: Support+ can unlock a firm user (common support task).
  // Drop legacy `minRole: 'admin'` to allow support to do it.
  permission: 'admin.firm.firm_user.unlock',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (
    ctx,
    { params }: { params: Promise<{ id: string; userId: string }> },
  ) => {
    const { id, userId } = await params;
    const { gate } = await parseDestructiveEnvelope(ctx.request);

    // BUG #58: password + TOTP reauth before lockout-bypass
    // (legitimate-looking session abuse vector, unlock a previously
    // bruteforced account to retry from inside).
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

    return handleAdminUnlockFirmUser(ctx, id, userId);
  },
});
