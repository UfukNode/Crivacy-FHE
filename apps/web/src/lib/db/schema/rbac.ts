import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { permissionDomainEnum, roleUserTypeEnum } from './enums';

/**
 * `permissions` — every atomic action in the system is represented as a
 * single permission with a `domain:action` code (e.g. `ticket:create`,
 * `credential:revoke`). The `domain` column groups permissions into
 * functional areas for easier management in the admin UI. Permissions
 * are immutable once seeded; the seed script in step 4 creates the full
 * set and any additions require a migration.
 */
export const permissions = pgTable('permissions', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  domain: permissionDomainEnum('domain').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;

/**
 * `roles` — named bundles of permissions. Two flavours exist:
 *
 *  1. **Preset roles** (`is_preset = true`) ship with the product and
 *     cannot be renamed or deleted by firm admins. They map 1:1 to the
 *     legacy enum values (`owner`, `admin`, `member`, `viewer` for firms;
 *     `superadmin`, `admin`, `support` for Crivacy staff).
 *
 *  2. **Custom roles** (`is_preset = false`) are created by firm owners
 *     for fine-grained delegation (e.g. `custom_reviewer` who can read
 *     KYC but not revoke credentials).
 *
 * `is_system` marks roles that the application depends on internally —
 * they cannot be deleted even by a superadmin (e.g. the `owner` preset).
 *
 * Soft-delete via `deleted_at` keeps referential integrity for audit
 * trails while removing the role from active use. The partial unique
 * index ensures that active (non-deleted) role names are unique per
 * `user_type`, but allows re-creation of a name after deletion.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    userType: roleUserTypeEnum('user_type').notNull(),
    isPreset: boolean('is_preset').notNull().default(false),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('roles_name_user_type_key')
      .on(table.name, table.userType)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;

/**
 * `role_permissions` — junction table linking roles to the permissions
 * they grant. Deleting a role cascades to remove its permission grants;
 * deleting a permission cascades to remove it from all roles. The
 * `granted_by` column is nullable because seed-time grants have no human
 * actor.
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    grantedBy: uuid('granted_by'),
  },
  (table) => [
    primaryKey({
      name: 'role_permissions_pk',
      columns: [table.roleId, table.permissionId],
    }),
  ],
);

export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;

/**
 * `user_roles` — assigns a role to a user. The polymorphic design uses
 * `user_id` + `user_type` instead of three separate FK columns; this
 * avoids N join tables (one per user table) and keeps the RBAC engine
 * user-type-agnostic.
 *
 * `user_id` is intentionally NOT a foreign key because it points to one
 * of three tables (`customers`, `firm_users`, `admin_users`) depending
 * on `user_type`. Referential integrity is enforced at the application
 * layer and verified by a nightly consistency check (step 10 polish).
 *
 * The unique constraint prevents double-assigning the same role, while
 * still allowing a user to hold multiple different roles.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    userType: roleUserTypeEnum('user_type').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    assignedBy: uuid('assigned_by'),
  },
  (table) => [
    uniqueIndex('user_roles_user_role_key').on(table.userId, table.userType, table.roleId),
    index('user_roles_user_idx').on(table.userId, table.userType),
    index('user_roles_role_id_idx').on(table.roleId),
  ],
);

export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
