/**
 * GET /api/internal/admin/me/permissions
 *
 * Admin-side twin of `/api/internal/me/permissions`. Returns the
 * effective permission set for the authenticated admin user, driving
 * the client-side `useAdminPermissions` hook.
 *
 * Intentionally NOT permission-gated, same reasoning as the firm
 * variant: a user must be able to read their own permission set to
 * render the admin UI correctly.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    return ctx.json({
      permissions: [...ctx.permissions].sort(),
      role: ctx.user.role,
    });
  },
});
