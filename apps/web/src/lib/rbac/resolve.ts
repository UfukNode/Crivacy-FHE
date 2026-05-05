/**
 * Effective permission resolution.
 *
 * The core RBAC query: given a user identity (`userId` + `userType`),
 * walk the join chain `user_roles -> roles -> role_permissions -> permissions`
 * and return the deduplicated set of permission codes. The result is a
 * plain `Set<string>` that the check utilities in `@/lib/rbac/check`
 * consume without further database access.
 *
 * This module is intentionally thin — it does one query and returns one
 * set. Caching (e.g. per-request memoisation inside middleware) belongs
 * in the caller, not here, so the function stays trivially testable
 * with a real or mock database.
 */

import { and, eq, isNull } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

/**
 * Resolve all effective permissions for a given user.
 *
 * Joins through the RBAC tables:
 *   `user_roles` -> `roles` -> `role_permissions` -> `permissions`
 *
 * Only active (non-deleted) roles are included. Returns a `Set` of
 * permission code strings (e.g. `"ticket:create"`, `"firm:view"`).
 *
 * @param db       - Drizzle database instance
 * @param userId   - UUID of the user (customer, firm_user, or admin_user)
 * @param userType - Discriminator for the polymorphic `user_roles` table
 * @returns Set of permission codes the user holds through all assigned roles
 */
export async function resolveEffectivePermissions(
  db: CrivacyDatabase,
  userId: string,
  userType: 'customer' | 'firm_user' | 'admin_user',
): Promise<Set<string>> {
  const rows = await db
    .select({ code: schema.permissions.code })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
    .innerJoin(schema.rolePermissions, eq(schema.roles.id, schema.rolePermissions.roleId))
    .innerJoin(schema.permissions, eq(schema.rolePermissions.permissionId, schema.permissions.id))
    .where(
      and(
        eq(schema.userRoles.userId, userId),
        eq(schema.userRoles.userType, userType),
        isNull(schema.roles.deletedAt),
      ),
    );

  return new Set(rows.map(r => r.code));
}
