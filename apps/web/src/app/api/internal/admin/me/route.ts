/**
 * GET /api/internal/admin/me
 *
 * Returns the authenticated admin user's basic identity info.
 * Used by the admin layout shell to populate the user menu.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Intentionally NOT permission-gated, app-shell identity lookup.
// Every logged-in admin needs this to render the user menu; gating
// would risk locking a user out of the dashboard shell entirely.
export const GET = adminRoute({
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    return ctx.json({
      id: ctx.user.id,
      email: ctx.user.email,
      displayName: ctx.user.displayName,
      role: ctx.user.role,
    }, 200);
  },
});
