/**
 * GET /api/internal/me/permissions
 *
 * Returns the effective permission set for the authenticated firm
 * user. Drives the client-side `useFirmPermissions` hook that gates
 * dashboard navigation, buttons, and inline actions.
 *
 * The set is computed at the middleware layer (`dashboardRoute`
 * resolves `user_roles` → `roles` → `role_permissions` → `permissions`
 * once per request) and attached to `ctx.permissions`. This handler
 * simply serialises it for the client.
 *
 * Intentionally NOT permission-gated, a user must be able to read
 * their own permission set to render the UI correctly, even if the
 * rest of their permission set is empty. Session authentication is
 * the security boundary; no cross-user data is returned.
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

export const GET = dashboardRoute({
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    // `ctx.permissions` is a ReadonlySet<string> built by the
    // middleware. Serialise as a sorted array so the response is
    // stable across requests (easier to cache, easier to diff in
    // audit contexts).
    return ctx.json({
      permissions: [...ctx.permissions].sort(),
      // Role included so the client can render "you are signed in
      // as Admin" affordances without a second /me request.
      role: ctx.user.role,
    });
  },
});
