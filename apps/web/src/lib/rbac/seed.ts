/**
 * Idempotent RBAC seed function.
 *
 * Creates all system permissions and preset roles defined in the
 * catalogue modules (`@/lib/rbac/permissions` and `@/lib/rbac/roles`).
 * Safe to run multiple times — uses `ON CONFLICT DO NOTHING` for
 * permissions and find-or-create logic for roles.
 *
 * This function is called during application startup and by the
 * migration tooling. It does NOT delete permissions or roles that
 * exist in the database but are absent from the catalogue; removal
 * requires an explicit migration to preserve audit trail integrity.
 */

import { and, eq } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

import { SYSTEM_PERMISSIONS } from './permissions';
import { PRESET_ROLES } from './roles';

/**
 * Seed all system permissions and preset roles. Idempotent — safe to
 * call on every deployment without data loss or duplication.
 *
 * Execution order:
 *  1. Upsert all permission rows (ON CONFLICT DO NOTHING on `code`)
 *  2. For each preset role: find-or-create the role row
 *  3. For each preset role: link its permission codes via `role_permissions`
 *     (ON CONFLICT DO NOTHING on the composite primary key)
 *
 * @param db - Drizzle database instance
 */
export async function seedRbac(db: CrivacyDatabase): Promise<void> {
  // ── 1. Upsert all system permissions ─────────────────────────────
  for (const perm of SYSTEM_PERMISSIONS) {
    await db
      .insert(schema.permissions)
      .values({
        code: perm.code,
        name: perm.name,
        description: perm.description,
        domain: perm.domain,
      })
      .onConflictDoNothing({ target: schema.permissions.code });
  }

  // ── 2. Upsert all preset roles and their permission assignments ──
  for (const roleDef of PRESET_ROLES) {
    // Find existing active role by (name, user_type) — the partial
    // unique index ensures at most one active row per combination.
    const existing = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.name, roleDef.name),
          eq(schema.roles.userType, roleDef.userType),
        ),
      )
      .limit(1);

    let roleId: string;

    const existingRow = existing[0];
    if (existingRow !== undefined) {
      roleId = existingRow.id;
    } else {
      const inserted = await db
        .insert(schema.roles)
        .values({
          name: roleDef.name,
          displayName: roleDef.displayName,
          description: roleDef.description,
          userType: roleDef.userType,
          isPreset: true,
          isSystem: roleDef.isSystem,
        })
        .returning({ id: schema.roles.id });
      const row = inserted[0];
      if (row === undefined) {
        throw new Error(`Failed to insert preset role '${roleDef.name}'`);
      }
      roleId = row.id;
    }

    // ── 3. Assign permissions to role ────────────────────────────
    for (const permCode of roleDef.permissions) {
      const [perm] = await db
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.code, permCode))
        .limit(1);

      if (perm) {
        await db
          .insert(schema.rolePermissions)
          .values({
            roleId,
            permissionId: perm.id,
          })
          .onConflictDoNothing();
      }
    }
  }
}
