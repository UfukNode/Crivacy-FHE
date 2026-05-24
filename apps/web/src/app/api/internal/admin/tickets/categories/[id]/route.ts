/**
 * PATCH  /api/internal/admin/tickets/categories/:id, update a category
 * DELETE /api/internal/admin/tickets/categories/:id, delete/deactivate a category
 *
 * Both require at least 'admin' role (manage_categories privilege).
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import {
  handleUpdateAdminCategory,
  handleDeleteAdminCategory,
} from '@/server/handlers/tickets';
import { adminRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = adminRoute({
  permission: 'admin.ticket.category_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;

    // Cat 38 destructive-reauth sweep follow-up (Page 7 closure):
    // category rename / toggle is admin-tier mutable state; gate
    // behind password+TOTP for parity with the firm-side reauth
    // sweep so the audit trail names a freshly-verified actor.
    const { rest, gate } = await parseDestructiveEnvelope(ctx.request);
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

    return handleUpdateAdminCategory(ctx, id, rest);
  },
});

export const DELETE = adminRoute({
  permission: 'admin.ticket.category_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;

    // Cat 38 destructive-reauth sweep follow-up (Page 7 closure):
    // category soft-delete deactivates referenced tickets'
    // taxonomy; hard-delete prunes the row outright. Either path
    // reshapes the support taxonomy and demands two-factor reauth.
    const envelope = await parseBody(ctx.request, z.object(reauthEnvelopeShape));
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'admin', id: ctx.user.id },
      envelope,
      now: ctx.now,
      authConfig: getAuthConfig(),
    });
    if (reauth.status === 'denied') {
      return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
    }

    return handleDeleteAdminCategory(ctx, id);
  },
});
