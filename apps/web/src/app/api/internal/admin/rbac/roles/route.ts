/**
 * GET  /api/internal/admin/rbac/roles, list all roles
 * POST /api/internal/admin/rbac/roles, create a custom role
 */

import { eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { writeAudit, adminUserActor, uuidTarget } from '@/lib/audit';
import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import * as schema from '@/lib/db/schema';
import { RbacError } from '@/lib/rbac/errors';
import { adminRoute } from '@/server/middleware';
import { parseBody, parseQuery } from '@/server/middleware/parse';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ListQuery = z.object({
  userType: z.enum(['customer', 'firm_user', 'admin_user']).optional(),
  includeDeleted: z.coerce.boolean().optional(),
});

const CreateBody = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[a-z][a-z0-9_]*$/,
      'Name must start with a letter and contain only lowercase letters, digits, and underscores',
    ),
  displayName: z.string().min(1).max(256),
  userType: z.enum(['customer', 'firm_user', 'admin_user']),
  description: z.string().max(1024).optional(),
});

export const GET = adminRoute({
  permission: 'admin.rbac.role_read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const query = parseQuery(new URL(ctx.request.url), ListQuery);

    let rows;
    if (query.includeDeleted) {
      if (query.userType) {
        rows = await ctx.db
          .select()
          .from(schema.roles)
          .where(eq(schema.roles.userType, query.userType));
      } else {
        rows = await ctx.db.select().from(schema.roles);
      }
    } else {
      if (query.userType) {
        const { and } = await import('drizzle-orm');
        rows = await ctx.db
          .select()
          .from(schema.roles)
          .where(
            and(
              isNull(schema.roles.deletedAt),
              eq(schema.roles.userType, query.userType),
            ),
          );
      } else {
        rows = await ctx.db
          .select()
          .from(schema.roles)
          .where(isNull(schema.roles.deletedAt));
      }
    }

    return ctx.json({ data: rows, pagination: { nextCursor: null, limit: rows.length } });
  },
});

const CreateBodyWithReauth = CreateBody.extend(reauthEnvelopeShape);

export const POST = adminRoute({
  permission: 'admin.rbac.role_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const parsed = await parseBody(ctx.request, CreateBodyWithReauth);
    const { currentPassword, totpCode, ...input } = parsed;

    // BUG #58: password + TOTP reauth before role create
    // (privilege escalation primitive, new role lets an attacker
    // mint custom permission bundles).
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

    // Check for duplicate name within the same userType (active roles only)
    const { and } = await import('drizzle-orm');
    const existing = await ctx.db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.name, input.name),
          eq(schema.roles.userType, input.userType),
          isNull(schema.roles.deletedAt),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw new RbacError('role_already_exists', `Role '${input.name}' already exists for user type '${input.userType}'.`);
    }

    const [role] = await ctx.db
      .insert(schema.roles)
      .values({
        name: input.name,
        displayName: input.displayName,
        userType: input.userType,
        description: input.description ?? null,
        isPreset: false,
        isSystem: false,
      })
      .returning();

    await writeAudit(ctx.db, {
      action: 'role.created',
      actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
      target: uuidTarget({ kind: 'role', id: role!.id }),
      meta: { name: input.name, userType: input.userType },
    });

    return ctx.json({ data: role }, 201);
  },
});
