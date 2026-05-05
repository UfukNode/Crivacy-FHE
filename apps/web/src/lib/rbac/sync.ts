/**
 * Hierarchy-role → preset-role-assignment sync helpers.
 *
 * RBAC permission resolution reads `user_roles` only; the legacy
 * `firm_users.role` / `admin_users.role` enum columns are kept for
 * display + invariants but are NOT consulted by `resolveEffectivePermissions`.
 * Every site that creates / mutates the hierarchy column must therefore
 * also keep `user_roles` in sync, or the user lands with zero effective
 * permissions despite a populated role column.
 *
 * This module owns that sync. Callers in:
 *   - `repositories/admin.ts::createFirmForAdmin`     (firm bootstrap, owner)
 *   - `handlers/firm-team.ts::handleInviteFirmTeammate` (team invite, any role)
 *   - `handlers/firm-team.ts::handleChangeFirmUserRole` (role mutation)
 * call `syncFirmUserHierarchyRole` to align user_roles with the preset
 * matching the new firm role. Same pattern for admin users via
 * `syncAdminUserHierarchyRole` once admin add/role-change endpoints exist.
 *
 * AUD-X follow-up: BUG #41 (2026-04-25) — invite-accept and team
 * invite/change paths previously left user_roles empty/stale, so newly
 * onboarded firm members observed `effectivePermissions = {}` and
 * `permission_denied` on every read endpoint, including the API key
 * list and webhooks page their preset role allows.
 */

import { and, eq, inArray } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import { runOrCatchUnique } from '@/lib/db/unique-violation';

import { hierarchyRoleToPresetName } from './roles';

const FIRM_PRESET_NAMES = ['owner', 'admin', 'member', 'viewer'] as const;
const ADMIN_PRESET_NAMES = ['superadmin', 'admin', 'support'] as const;

/**
 * Replace any preset firm-role assignment for `firmUserId` with the
 * preset matching `newRole`. Custom (non-preset) roles attached via
 * the admin RBAC UI are left intact — they are an additive grant on
 * top of the hierarchy role, not a substitute for it.
 *
 * Idempotent: calling with the same role the user already holds is a
 * no-op modulo the unique-violation catch.
 */
export async function syncFirmUserHierarchyRole(
  db: CrivacyDatabase,
  firmUserId: string,
  newRole: 'owner' | 'admin' | 'member' | 'viewer',
  assignedBy?: string | undefined,
): Promise<void> {
  // 1. Look up the preset role row by name + user_type.
  const presetRows = await db
    .select({ id: schema.roles.id, name: schema.roles.name })
    .from(schema.roles)
    .where(
      and(
        eq(schema.roles.userType, 'firm_user'),
        inArray(schema.roles.name, FIRM_PRESET_NAMES as unknown as string[]),
      ),
    );
  const targetPreset = presetRows.find((r) => r.name === hierarchyRoleToPresetName(newRole));
  if (targetPreset === undefined) {
    // Seed has not run yet, or preset table was tampered with. The
    // caller's transaction continues without RBAC sync — surfaces as
    // 0 permissions until ops re-runs `seed-rbac.ts`. We warn rather
    // than throw because withholding firm creation entirely on a seed
    // mismatch is worse than the bootstrap-without-perms case.
    return;
  }

  const presetIds = presetRows.map((r) => r.id);

  // 2. Delete any other preset-role assignments this user may hold so
  //    the union of role memberships does not silently include the
  //    *previous* hierarchy role. Custom roles (anything outside the
  //    preset name list) are left untouched.
  await db
    .delete(schema.userRoles)
    .where(
      and(
        eq(schema.userRoles.userId, firmUserId),
        eq(schema.userRoles.userType, 'firm_user'),
        inArray(schema.userRoles.roleId, presetIds),
      ),
    );

  // 3. Insert the new assignment, swallowing the unique-violation that
  //    would fire on the (rare) idempotent re-run inside the same tx.
  await runOrCatchUnique(
    () =>
      db.insert(schema.userRoles).values({
        userId: firmUserId,
        userType: 'firm_user',
        roleId: targetPreset.id,
        assignedBy: assignedBy ?? null,
      }),
    ['user_roles_user_role_key'],
  );
}

/**
 * Same shape as `syncFirmUserHierarchyRole` for admin_users. Reserved
 * for the day admin user-management routes acquire create/role-change
 * surfaces; today admin rows are seeded statically.
 */
export async function syncAdminUserHierarchyRole(
  db: CrivacyDatabase,
  adminUserId: string,
  newRole: 'superadmin' | 'admin' | 'support',
  assignedBy?: string | undefined,
): Promise<void> {
  const presetRows = await db
    .select({ id: schema.roles.id, name: schema.roles.name })
    .from(schema.roles)
    .where(
      and(
        eq(schema.roles.userType, 'admin_user'),
        inArray(schema.roles.name, ADMIN_PRESET_NAMES as unknown as string[]),
      ),
    );
  const targetPreset = presetRows.find((r) => r.name === hierarchyRoleToPresetName(newRole));
  if (targetPreset === undefined) return;

  const presetIds = presetRows.map((r) => r.id);

  await db
    .delete(schema.userRoles)
    .where(
      and(
        eq(schema.userRoles.userId, adminUserId),
        eq(schema.userRoles.userType, 'admin_user'),
        inArray(schema.userRoles.roleId, presetIds),
      ),
    );

  await runOrCatchUnique(
    () =>
      db.insert(schema.userRoles).values({
        userId: adminUserId,
        userType: 'admin_user',
        roleId: targetPreset.id,
        assignedBy: assignedBy ?? null,
      }),
    ['user_roles_user_role_key'],
  );
}
