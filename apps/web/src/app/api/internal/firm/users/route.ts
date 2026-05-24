/**
 * GET  /api/internal/firm/users, list teammates of the caller's firm.
 * POST /api/internal/firm/users, invite a new teammate.
 *
 * Owner + admin can invite (capability `manageTeam`). Member and
 * viewer get 403 at the policy layer.
 */

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import {
  handleInviteFirmTeammate,
  handleListFirmTeam,
} from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = dashboardRoute({
  permission: 'firm.user.read',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: (ctx) => handleListFirmTeam(ctx),
});

export const POST = dashboardRoute({
  // `manageTeam` requires admin or owner. `minRole: 'admin'` keeps
  // the middleware gate consistent with the capability table in
  // `lib/firm/roles.ts`, members and viewers never reach the
  // handler, so we don't rely on a deeper check to 403 them.
  permission: 'firm.user.invite',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    // Per-IP cap. Each invite fires a transactional email, a stolen
    // firm-admin session without this cap could otherwise mass-mail
    // arbitrary addresses.
    const limited = await maybeRateLimitResponse(ctx.db, 'firm_users_invite', ctx.ip, ctx.now);
    if (limited) return limited;
    return handleInviteFirmTeammate(ctx);
  },
});
