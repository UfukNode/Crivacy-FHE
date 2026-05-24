/**
 * GET /api/internal/admin/rbac/permissions, list all system permissions
 *
 * Returns the full catalogue of atomic permissions defined in the
 * `@/lib/rbac/permissions` module. This is a static list; it does not
 * hit the database. Useful for the admin UI to display permission
 * checkboxes when editing a role.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { SYSTEM_PERMISSIONS } from '@/lib/rbac/permissions';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  // Read-only catalogue, Support+ needs to view permissions to
  // understand role assignments they see.
  permission: 'admin.rbac.role_read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    return ctx.json({
      data: SYSTEM_PERMISSIONS,
      pagination: { nextCursor: null, limit: SYSTEM_PERMISSIONS.length },
    });
  },
});
