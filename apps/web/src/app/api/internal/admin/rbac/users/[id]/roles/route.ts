/**
 * GET /api/internal/admin/rbac/users/:id/roles, get user's roles
 * PUT /api/internal/admin/rbac/users/:id/roles, set user's roles (full replace)
 */

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { writeAudit, adminUserActor, uuidTarget } from '@/lib/audit';
import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import * as schema from '@/lib/db/schema';
import { assertCanAssignSystemRoles } from '@/lib/rbac/assignment';
import { RbacError } from '@/lib/rbac/errors';
import { adminRoute } from '@/server/middleware';
import { parseBody, parseQuery } from '@/server/middleware/parse';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GetQuery = z.object({
  userType: z.enum(['customer', 'firm_user', 'admin_user']),
});

const SetBody = z.object({
  userType: z.enum(['customer', 'firm_user', 'admin_user']),
  roleIds: z.array(z.string().uuid()).min(0).max(50),
});

export const GET = adminRoute({
  permission: 'admin.rbac.role_read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: userId } = await params;
    const query = parseQuery(new URL(ctx.request.url), GetQuery);

    const assignments = await ctx.db
      .select({
        roleId: schema.userRoles.roleId,
        roleName: schema.roles.name,
        roleDisplayName: schema.roles.displayName,
        isPreset: schema.roles.isPreset,
        isSystem: schema.roles.isSystem,
        assignedAt: schema.userRoles.assignedAt,
        assignedBy: schema.userRoles.assignedBy,
      })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
      .where(
        and(
          eq(schema.userRoles.userId, userId),
          eq(schema.userRoles.userType, query.userType),
        ),
      );

    return ctx.json({
      data: assignments,
      pagination: { nextCursor: null, limit: assignments.length },
    });
  },
});

const SetBodyWithReauth = SetBody.extend(reauthEnvelopeShape);

export const PUT = adminRoute({
  // Role assignment, Admin+ can assign Support/Admin, but the
  // handler guards "atanacak rol Superadmin ise sadece Superadmin
  // assigns Superadmin" (privilege escalation defence).
  permission: 'admin.rbac.user_role_assign',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: userId } = await params;
    const parsed = await parseBody(ctx.request, SetBodyWithReauth);
    const { currentPassword, totpCode, ...input } = parsed;

    // BUG #58: password + TOTP reauth before role assignment
    // (privilege escalation primitive, bestowing Superadmin on a
    // compromised admin account).
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

    // Validate all role IDs exist and match the user type
    if (input.roleIds.length > 0) {
      const { inArray } = await import('drizzle-orm');
      const validRoles = await ctx.db
        .select({
          id: schema.roles.id,
          name: schema.roles.name,
          isSystem: schema.roles.isSystem,
        })
        .from(schema.roles)
        .where(
          and(
            inArray(schema.roles.id, input.roleIds),
            eq(schema.roles.userType, input.userType),
            isNull(schema.roles.deletedAt),
          ),
        );

      const validIds = new Set(validRoles.map((r) => r.id));
      const invalidIds = input.roleIds.filter((rid) => !validIds.has(rid));
      if (invalidIds.length > 0) {
        throw new RbacError(
          'role_not_found',
          `Role IDs not found or wrong user type: ${invalidIds.join(', ')}`,
        );
      }

      // Privilege-escalation guard (AUDIT C-1 / BUG #58): the route
      // docstring has always promised that assigning a system role
      // (Superadmin / Owner presets) requires the caller to be a
      // Superadmin, but the check was missing, letting any admin with
      // `admin.rbac.user_role_assign` grant itself Superadmin. The
      // reauth above only proves the caller owns *their own*
      // credentials, not that they may elevate.
      assertCanAssignSystemRoles(ctx.user.role, validRoles);
    }

    // Fetch current assignments for audit diff
    const currentAssignments = await ctx.db
      .select({
        roleId: schema.userRoles.roleId,
        roleName: schema.roles.name,
      })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
      .where(
        and(
          eq(schema.userRoles.userId, userId),
          eq(schema.userRoles.userType, input.userType),
        ),
      );

    const currentRoleIds = new Set(currentAssignments.map((a) => a.roleId));
    const newRoleIds = new Set(input.roleIds);
    const assigned = input.roleIds.filter((rid) => !currentRoleIds.has(rid));
    const unassigned = [...currentRoleIds].filter((rid) => !newRoleIds.has(rid));

    // Transaction: delete all existing, insert new
    await ctx.db.transaction(async (tx) => {
      await tx
        .delete(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.userId, userId),
            eq(schema.userRoles.userType, input.userType),
          ),
        );

      if (input.roleIds.length > 0) {
        const rows = input.roleIds.map((roleId) => ({
          userId,
          userType: input.userType as 'customer' | 'firm_user' | 'admin_user',
          roleId,
          assignedBy: ctx.user.id,
        }));
        await tx.insert(schema.userRoles).values(rows);
      }
    });

    // Audit: log assigned and unassigned separately
    if (assigned.length > 0) {
      await writeAudit(ctx.db, {
        action: 'role.assigned',
        actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
        target: uuidTarget({ kind: 'role', id: userId }),
        meta: { userId, userType: input.userType, roleIds: assigned },
      });
    }
    if (unassigned.length > 0) {
      await writeAudit(ctx.db, {
        action: 'role.unassigned',
        actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
        target: uuidTarget({ kind: 'role', id: userId }),
        meta: { userId, userType: input.userType, roleIds: unassigned },
      });
    }

    // Return the new assignments
    const updatedAssignments = await ctx.db
      .select({
        roleId: schema.userRoles.roleId,
        roleName: schema.roles.name,
        roleDisplayName: schema.roles.displayName,
        isPreset: schema.roles.isPreset,
        isSystem: schema.roles.isSystem,
        assignedAt: schema.userRoles.assignedAt,
        assignedBy: schema.userRoles.assignedBy,
      })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
      .where(
        and(
          eq(schema.userRoles.userId, userId),
          eq(schema.userRoles.userType, input.userType),
        ),
      );

    return ctx.json({
      data: updatedAssignments,
      pagination: { nextCursor: null, limit: updatedAssignments.length },
    });
  },
});
