/**
 * GET /api/internal/admin/rbac/roles/:id/permissions, list role's permissions
 * PUT /api/internal/admin/rbac/roles/:id/permissions, full replace of role's permissions
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { writeAudit, adminUserActor, uuidTarget } from '@/lib/audit';
import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import * as schema from '@/lib/db/schema';
import { RbacError } from '@/lib/rbac/errors';
import { ALL_PERMISSION_CODES } from '@/lib/rbac/permissions';
import { adminRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ReplaceBody = z.object({
  permissions: z.array(z.string().min(1).max(128)).min(0).max(200),
});

export const GET = adminRoute({
  permission: 'admin.rbac.role_read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;

    // Verify role exists
    const [role] = await ctx.db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.id, id))
      .limit(1);

    if (role === undefined) {
      return ctx.errorJson('not_found', 'Role not found.', 404);
    }

    const perms = await ctx.db
      .select({
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

    const codes = perms.map((p) => p.code);
    return ctx.json({ data: codes, pagination: { nextCursor: null, limit: codes.length } });
  },
});

const ReplaceBodyWithReauth = ReplaceBody.extend(reauthEnvelopeShape);

export const PUT = adminRoute({
  permission: 'admin.rbac.permission_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const parsed = await parseBody(ctx.request, ReplaceBodyWithReauth);
    const { currentPassword, totpCode, ...input } = parsed;

    // BUG #58: password + TOTP reauth before role-permission
    // replace (privilege escalation primitive, every user holding
    // the role inherits the new bundle).
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

    // Verify role exists and is not system
    const [role] = await ctx.db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.id, id))
      .limit(1);

    if (role === undefined || role.deletedAt !== null) {
      return ctx.errorJson('not_found', 'Role not found.', 404);
    }

    if (role.isSystem) {
      throw new RbacError('role_is_system', 'System role permissions cannot be modified.');
    }

    // Validate all permission codes exist in the catalogue
    const invalidCodes: string[] = [];
    for (const code of input.permissions) {
      if (!ALL_PERMISSION_CODES.has(code)) {
        invalidCodes.push(code);
      }
    }
    if (invalidCodes.length > 0) {
      throw new RbacError(
        'permission_not_found',
        `Unknown permission codes: ${invalidCodes.join(', ')}`,
      );
    }

    // Resolve permission UUIDs from codes
    const { inArray } = await import('drizzle-orm');
    let permissionRows: { id: string; code: string }[] = [];
    if (input.permissions.length > 0) {
      permissionRows = await ctx.db
        .select({ id: schema.permissions.id, code: schema.permissions.code })
        .from(schema.permissions)
        .where(inArray(schema.permissions.code, input.permissions));
    }

    // Build a map for quick lookup
    const codeToId = new Map(permissionRows.map((p) => [p.code, p.id]));

    // Verify all requested codes resolved
    for (const code of input.permissions) {
      if (!codeToId.has(code)) {
        throw new RbacError('permission_not_found', `Permission '${code}' not found in database. Run the seed script.`);
      }
    }

    // Fetch current permissions for diff in audit log
    const currentPerms = await ctx.db
      .select({ code: schema.permissions.code })
      .from(schema.rolePermissions)
      .innerJoin(
        schema.permissions,
        eq(schema.rolePermissions.permissionId, schema.permissions.id),
      )
      .where(eq(schema.rolePermissions.roleId, id));

    const currentCodes = new Set(currentPerms.map((p) => p.code));
    const newCodes = new Set(input.permissions);
    const granted = input.permissions.filter((c) => !currentCodes.has(c));
    const revoked = [...currentCodes].filter((c) => !newCodes.has(c));

    // Transaction: delete all existing, insert new
    await ctx.db.transaction(async (tx) => {
      // Remove all existing permission grants
      await tx
        .delete(schema.rolePermissions)
        .where(eq(schema.rolePermissions.roleId, id));

      // Insert new grants
      if (input.permissions.length > 0) {
        const rows = input.permissions.map((code) => ({
          roleId: id,
          permissionId: codeToId.get(code)!,
          grantedBy: ctx.user.id,
        }));
        await tx.insert(schema.rolePermissions).values(rows);
      }
    });

    // Audit: log granted and revoked separately for clarity
    if (granted.length > 0) {
      await writeAudit(ctx.db, {
        action: 'role.permission_granted',
        actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
        target: uuidTarget({ kind: 'role', id }),
        meta: { roleName: role.name, permissions: granted },
      });
    }
    if (revoked.length > 0) {
      await writeAudit(ctx.db, {
        action: 'role.permission_revoked',
        actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
        target: uuidTarget({ kind: 'role', id }),
        meta: { roleName: role.name, permissions: revoked },
      });
    }

    return ctx.json({
      data: input.permissions,
      pagination: { nextCursor: null, limit: input.permissions.length },
    });
  },
});
