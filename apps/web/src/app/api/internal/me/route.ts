/**
 * GET /api/internal/me
 *
 * Returns the authenticated firm user's basic identity info.
 * Used by the dashboard layout shell to populate the user menu.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Intentionally NOT permission-gated, this is the app-shell
// identity lookup every logged-in firm user needs to render the
// user menu. Gating it would risk a user with an edge-case empty
// permission set being unable to load the dashboard at all. Session
// authentication alone is the security boundary here; no firm data
// beyond the caller's own identity is returned.
export const GET = dashboardRoute({
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    return ctx.json({
      id: ctx.user.id,
      email: ctx.user.email,
      role: ctx.user.role,
      firmId: ctx.user.firmId,
      firmName: ctx.firm.displayName,
    }, 200);
  },
});
