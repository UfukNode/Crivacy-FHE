/**
 * GET /api/internal/admin/users, list active admin users.
 *
 * Returns the roster of admin accounts that can be picked as a ticket
 * assignee (support/admin/superadmin roles). Locked accounts are excluded
 * so they never appear in assignment dropdowns. All admin roles may read
 * this list (support and above) since assignment is a common operational
 * need.
 *
 * This is a lightweight list endpoint, no pagination, no filtering: the
 * admin roster is expected to stay small (dozens, not thousands). If the
 * volume ever grows we can add server-side search here without changing
 * the URL shape.
 */

import { asc, isNull } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import * as schema from '@/lib/db/schema';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  permission: 'admin.user.read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const users = await ctx.db
      .select({
        id: schema.adminUsers.id,
        email: schema.adminUsers.email,
        displayName: schema.adminUsers.displayName,
        role: schema.adminUsers.role,
      })
      .from(schema.adminUsers)
      .where(isNull(schema.adminUsers.lockedAt))
      .orderBy(asc(schema.adminUsers.displayName));

    return ctx.json({ data: users, pagination: { nextCursor: null, limit: users.length } });
  },
});
