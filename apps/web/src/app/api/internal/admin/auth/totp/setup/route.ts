/**
 * POST /api/internal/admin/auth/totp/setup
 *
 * Generate a candidate TOTP secret + otpauth URL for an admin who is
 * enrolling (or re-enrolling) their authenticator app. Mirrors the
 * firm-side setup endpoint, the secret is not persisted until
 * `/profile/totp/replace` verifies a code against it, so repeated
 * calls just hand back fresh candidates without side effects.
 */

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { handleTotpSetup } from '@/server/handlers';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = adminRoute({
  permission: 'profile.totp_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    // Per-IP cap, stolen admin session without this would let an
    // attacker burn randomness + noise the audit stream.
    const limited = await maybeRateLimitResponse(ctx.db, 'admin_totp_setup', ctx.ip, ctx.now);
    if (limited) return limited;

    const result = handleTotpSetup({ authConfig: getAuthConfig() }, ctx.user.email);
    return ctx.json(result);
  },
});
