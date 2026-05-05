/**
 * Role assignment operations.
 *
 * Functions to assign and remove roles from users. All mutations go
 * through the `user_roles` junction table and respect the polymorphic
 * `user_type` discriminator. Conflict handling ensures idempotent
 * assign calls and clear error reporting for invalid operations.
 *
 * Every function follows the dependency-injection pattern: the first
 * argument is always `db: CrivacyDatabase` so callers can pass a
 * transaction or a test double.
 */

import { and, eq } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { runOrCatchUnique } from '@/lib/db/unique-violation';
import * as schema from '@/lib/db/schema';

import { RbacError } from './errors';

/**
 * Privilege-escalation guard for role assignment (AUDIT C-1 / BUG #58).
 *
 * Only a Superadmin may assign a *system* role. The Superadmin and Owner
 * presets are flagged `isSystem: true`; granting one bestows the highest
 * authority on the platform (or a firm). The admin RBAC route gates the
 * endpoint on `admin.rbac.user_role_assign`, which the plain `admin`
 * preset holds, and the destructive-reauth there only proves the caller
 * controls *their own* credentials — neither establishes that a
 * non-Superadmin is entitled to elevate someone to Superadmin. Without
 * this check a plain `admin` could grant itself Superadmin in a single
 * request.
 *
 * Throws `RbacError('permission_denied')` when a non-Superadmin caller
 * includes any system role in the assignment set; no-op otherwise.
 *
 * Pure (no IO) so it is trivially unit-testable and can run before the
 * assignment transaction.
 */
export function assertCanAssignSystemRoles(
  callerRole: 'superadmin' | 'admin' | 'support',
  requestedRoles: ReadonlyArray<{ readonly name: string; readonly isSystem: boolean }>,
): void {
  if (callerRole === 'superadmin') return;
  const systemRoles = requestedRoles.filter((r) => r.isSystem);
  if (systemRoles.length > 0) {
    throw new RbacError(
      'permission_denied',
      `Only a Superadmin can assign system roles: ${systemRoles
        .map((r) => r.name)
        .join(', ')}.`,
    );
  }
}

/**
 * Assign a role to a user. Throws `RbacError` if:
 *  - The role does not exist or is soft-deleted (`role_not_found`)
 *  - The role's `user_type` does not match the given `userType` (`invalid_user_type`)
 *  - The user already holds this role (`user_already_has_role`)
 *
 * @param db         - Drizzle database instance
 * @param userId     - UUID of the target user
 * @param userType   - Must match the role's `user_type`
 * @param roleId     - UUID of the role to assign
 * @param assignedBy - UUID of the actor performing the assignment (optional for system operations)
 */
export async function assignRoleToUser(
  db: CrivacyDatabase,
  userId: string,
  userType: 'customer' | 'firm_user' | 'admin_user',
  roleId: string,
  assignedBy?: string | undefined,
): Promise<void> {
  // Verify the role exists and is not soft-deleted
  const [role] = await db
    .select({
      id: schema.roles.id,
      userType: schema.roles.userType,
      deletedAt: schema.roles.deletedAt,
    })
    .from(schema.roles)
    .where(eq(schema.roles.id, roleId))
    .limit(1);

  if (!role || role.deletedAt !== null) {
    throw new RbacError('role_not_found', `Role ${roleId} does not exist or has been deleted`);
  }

  // Verify user_type matches
  if (role.userType !== userType) {
    throw new RbacError(
      'invalid_user_type',
      `Role ${roleId} is for user type '${role.userType}', cannot assign to '${userType}'`,
    );
  }

  // AUD-INT-AUTHZ-RACE-001 fix: atomic INSERT + unique-violation
  // catch instead of SELECT-then-INSERT. The previous check-then-act
  // raced under parallel "add role" clicks — both callers saw no
  // existing row and both tried to INSERT, the second hitting
  // `user_roles_user_role_key` with a raw 23505 that bubbled up as
  // a 500 to the admin UI. Aligning with `runOrCatchUnique` — the
  // canonical pattern the rest of the codebase uses for "exists?
  // insert : error" flows (e.g. email-change, add-email) — keeps the
  // semantic error (`user_already_has_role`) while making the check
  // race-safe in one round-trip.
  const insertResult = await runOrCatchUnique(
    () =>
      db.insert(schema.userRoles).values({
        userId,
        userType,
        roleId,
        assignedBy: assignedBy ?? null,
      }),
    ['user_roles_user_role_key'],
  );
  if (insertResult.status === 'violation') {
    throw new RbacError(
      'user_already_has_role',
      `User ${userId} already has role ${roleId}`,
    );
  }
}

/**
 * Remove a role from a user. Throws `RbacError` if:
 *  - The assignment does not exist (`user_role_not_found`)
 *
 * @param db       - Drizzle database instance
 * @param userId   - UUID of the target user
 * @param userType - Must match the assignment's `user_type`
 * @param roleId   - UUID of the role to remove
 */
export async function removeRoleFromUser(
  db: CrivacyDatabase,
  userId: string,
  userType: 'customer' | 'firm_user' | 'admin_user',
  roleId: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: schema.userRoles.id })
    .from(schema.userRoles)
    .where(
      and(
        eq(schema.userRoles.userId, userId),
        eq(schema.userRoles.userType, userType),
        eq(schema.userRoles.roleId, roleId),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new RbacError(
      'user_role_not_found',
      `User ${userId} does not have role ${roleId}`,
    );
  }

  await db
    .delete(schema.userRoles)
    .where(eq(schema.userRoles.id, existing.id));
}

/**
 * Get all role IDs currently assigned to a user.
 *
 * @param db       - Drizzle database instance
 * @param userId   - UUID of the target user
 * @param userType - Discriminator for the polymorphic `user_roles` table
 * @returns Array of role UUIDs
 */
export async function getUserRoleIds(
  db: CrivacyDatabase,
  userId: string,
  userType: 'customer' | 'firm_user' | 'admin_user',
): Promise<string[]> {
  const rows = await db
    .select({ roleId: schema.userRoles.roleId })
    .from(schema.userRoles)
    .where(
      and(
        eq(schema.userRoles.userId, userId),
        eq(schema.userRoles.userType, userType),
      ),
    );

  return rows.map(r => r.roleId);
}
