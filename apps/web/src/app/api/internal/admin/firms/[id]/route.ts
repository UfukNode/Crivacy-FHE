/**
 * GET    /api/internal/admin/firms/:id, get firm details
 * PATCH  /api/internal/admin/firms/:id, update firm
 * DELETE /api/internal/admin/firms/:id, soft delete firm
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import {
  handleGetAdminFirmDetail,
  handleSoftDeleteFirm,
  handleUpdateFirm,
} from '@/server/handlers';
import { adminRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  createFirmForAdmin,
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
  getFirmForAdmin,
  listFirmsForAdmin,
  restoreFirmForAdmin,
  softDeleteFirmForAdmin,
  updateFirmForAdmin,
} from '@/server/repositories';

import { emailSchema } from '@/lib/validation/auth';
import { firmNameSchema, firmTierSchema, countryCodeSchema } from '@/lib/validation/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UpdateBody = z.object({
  name: firmNameSchema.optional(),
  tier: firmTierSchema.optional(),
  contactEmail: emailSchema.optional(),
  countryCode: countryCodeSchema.optional(),
  notes: z.string().max(2048).optional(),
});

function getDeps() {
  return {
    listFirms: listFirmsForAdmin,
    createFirm: createFirmForAdmin,
    updateFirm: updateFirmForAdmin,
    softDeleteFirm: softDeleteFirmForAdmin,
    restoreFirm: restoreFirmForAdmin,
    getFirm: getFirmForAdmin,
  };
}

export const GET = adminRoute({
  permission: 'admin.firm.read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleGetAdminFirmDetail(ctx, id);
  },
});

export const PATCH = adminRoute({
  permission: 'admin.firm.update',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const merged = UpdateBody.merge(z.object(reauthEnvelopeShape));
    const parsed = await parseBody(ctx.request, merged);
    const { currentPassword, totpCode, ...input } = parsed;

    // BUG #58: password + TOTP reauth before firm-level mutation
    // (suspend/tier change/contact rotation).
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

    const result = await handleUpdateFirm(getDeps(), ctx, id, input);
    if (result === null) {
      return ctx.errorJson('not_found', 'Firm not found.', 404);
    }
    return ctx.json(result);
  },
});

export const DELETE = adminRoute({
  // Soft-delete is "strong suspension" in our model, marks
  // `deletedAt` but keeps the row for audit and restore. Gated on
  // `admin.firm.suspend` so Admin+ can initiate (same tier that can
  // suspend). The restore path (AUD-FRM-AUDIT...) is Superadmin-only
  // via `admin.firm.restore`, so Admin can mistakenly delete but
  // cannot reverse their own mistake without Superadmin help, a
  // deliberate "two-key" safety net for terminal-ish ops.
  permission: 'admin.firm.suspend',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const { gate } = await parseDestructiveEnvelope(ctx.request);

    // BUG #58: password + TOTP reauth before firm soft-delete
    // (terminal-ish, two-key restore via Superadmin).
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

    await handleSoftDeleteFirm(getDeps(), ctx, id);
    return ctx.noContent();
  },
});
