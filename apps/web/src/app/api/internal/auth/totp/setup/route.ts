/**
 * POST /api/internal/auth/totp/setup
 *
 * Generate a new TOTP secret + otpauth URL. Does NOT persist until
 * the user verifies via /totp/verify.
 */

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { handleTotpSetup } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = dashboardRoute({
  permission: 'profile.totp_manage',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    // Per-IP rate limit, an attacker with a stolen session cookie
    // could otherwise spam candidate-secret generation indefinitely,
    // inflating the audit log and burning randomness.
    const limited = await maybeRateLimitResponse(ctx.db, 'firm_totp_setup', ctx.ip, ctx.now);
    if (limited) return limited;

    const result = handleTotpSetup({ authConfig: getAuthConfig() }, ctx.user.email);
    return ctx.json(result);
  },
});
