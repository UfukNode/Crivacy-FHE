/**
 * GET    /api/internal/admin/rbac/roles/:id, get role details + permissions
 * PATCH  /api/internal/admin/rbac/roles/:id, update role (name, displayName, description)
 * DELETE /api/internal/admin/rbac/roles/:id, soft-delete role
 */

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { writeAudit, adminUserActor, uuidTarget } from '@/lib/audit';
import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import * as schema from '@/lib/db/schema';
import { RbacError } from '@/lib/rbac/errors';
import { adminRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UpdateBody = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[a-z][a-z0-9_]*$/,
      'Name must start with a letter and contain only lowercase letters, digits, and underscores',
    )
    .optional(),
  displayName: z.string().min(1).max(256).optional(),
  description: z.string().max(1024).optional(),
});

export const GET = adminRoute({
  permission: 'admin.rbac.role_read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;

    const [role] = await ctx.db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.id, id))
      .limit(1);

    if (role === undefined) {
      return ctx.errorJson('not_found', 'Role not found.', 404);
    }

    // Fetch permissions for this role
    const perms = await ctx.db
      .select({
        permissionId: schema.rolePermissions.permissionId,
        code: schema.permissions.code,
        name: schema.permissions.name,
        domain: schema.permissions.domain,
        grantedAt: schema.rolePermissions.grantedAt,
      })
      .from(schema.rolePermissions)
      .innerJoin(
        schema.permissions,
        eq(schema.rolePermissions.permissionId, schema.permissions.id),
      )
      .where(eq(schema.rolePermissions.roleId, id));

    return ctx.json({ data: { ...role, permissions: perms } });
  },
});

const UpdateBodyWithReauth = UpdateBody.merge(z.object(reauthEnvelopeShape));

export const PATCH = adminRoute({
  permission: 'admin.rbac.role_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const parsed = await parseBody(ctx.request, UpdateBodyWithReauth);
    const { currentPassword, totpCode, ...input } = parsed;

    // BUG #58: password + TOTP reauth before role mutation
    // (rename / preset description override, affects every user
    // holding the role).
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'admin', id: ctx.user.id },
      envelope: { currentPassword, totpCode },
      now: ctx.now,
      authConfig: getAuthConfig(),
    });
    if (reauth.status === 'denied') {
      return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
    }

    // Fetch existing role
    const [existing] = await ctx.db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.id, id))
      .limit(1);

    if (existing === undefined) {
      return ctx.errorJson('not_found', 'Role not found.', 404);
    }

    if (existing.deletedAt !== null) {
      return ctx.errorJson('not_found', 'Role has been deleted.', 404);
    }

    // System roles cannot be modified
    if (existing.isSystem) {
      throw new RbacError('role_is_system', 'System roles cannot be modified.');
    }

    // Preset roles: only description can be changed
    if (existing.isPreset && (input.name !== undefined || input.displayName !== undefined)) {
      throw new RbacError('role_is_preset', 'Preset roles can only have their description updated.');
    }

    // If renaming, check for duplicates
    if (input.name !== undefined && input.name !== existing.name) {
      const dup = await ctx.db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(
          and(
            eq(schema.roles.name, input.name),
            eq(schema.roles.userType, existing.userType),
            isNull(schema.roles.deletedAt),
          ),
        )
        .limit(1);

      if (dup.length > 0) {
        throw new RbacError('role_already_exists', `Role '${input.name}' already exists for user type '${existing.userType}'.`);
      }
    }

    const [updated] = await ctx.db
      .update(schema.roles)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.roles.id, id))
      .returning();

    await writeAudit(ctx.db, {
      action: 'role.updated',
      actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
      target: uuidTarget({ kind: 'role', id }),
      meta: { changes: input },
    });

    return ctx.json({ data: updated });
  },
});

export const DELETE = adminRoute({
  permission: 'admin.rbac.role_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const { gate } = await parseDestructiveEnvelope(ctx.request);

    // BUG #58: password + TOTP reauth before role soft-delete
    // (irreversible-ish; prior assignments must be unassigned
    // first but the role row is then unrecoverable).
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'admin', id: ctx.user.id },
      envelope: gate,
      now: ctx.now,
      authConfig: getAuthConfig(),
    });
    if (reauth.status === 'denied') {
      return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
    }

    const [existing] = await ctx.db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.id, id))
      .limit(1);

    if (existing === undefined) {
      return ctx.errorJson('not_found', 'Role not found.', 404);
    }

    if (existing.deletedAt !== null) {
      return ctx.errorJson('not_found', 'Role has already been deleted.', 404);
    }

    if (existing.isSystem) {
      throw new RbacError('role_is_system', 'System roles cannot be deleted.');
    }

    // Check if any users hold this role
    const assignments = await ctx.db
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(eq(schema.userRoles.roleId, id))
      .limit(1);

    if (assignments.length > 0) {
      throw new RbacError('role_has_users', 'Cannot delete role that is still assigned to users. Unassign all users first.');
    }

    // Soft-delete
    await ctx.db
      .update(schema.roles)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.roles.id, id));

    await writeAudit(ctx.db, {
      action: 'role.deleted',
      actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
      target: uuidTarget({ kind: 'role', id }),
      meta: { name: existing.name, userType: existing.userType },
    });

    return ctx.noContent();
  },
});
