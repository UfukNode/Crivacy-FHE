/**
 * GET  /api/internal/admin/firms, list all firms
 * POST /api/internal/admin/firms, create a new firm
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { handleCreateFirm, handleListFirms } from '@/server/handlers';
import { adminRoute } from '@/server/middleware';
import { parseBody, parseQuery } from '@/server/middleware/parse';
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
import { firmNameSchema, firmSlugSchema, firmTierSchema, countryCodeSchema } from '@/lib/validation/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ListQuery = z.object({
  includeDeleted: z.coerce.boolean().optional(),
  tier: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const CreateBody = z.object({
  name: firmNameSchema,
  slug: firmSlugSchema,
  tier: firmTierSchema,
  contactEmail: emailSchema,
  countryCode: countryCodeSchema.optional(),
  /**
   * Dashboard owner email, required. The first firm_user is
   * created here (password-less) and receives a welcome email with a
   * single-use invitation link to complete onboarding.
   */
  ownerEmail: emailSchema,
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
  handler: async (ctx) => {
    const query = parseQuery(new URL(ctx.request.url), ListQuery);
    const result = await handleListFirms(getDeps(), ctx, query);
    return ctx.json(result);
  },
});

const CreateBodyWithReauth = CreateBody.extend(reauthEnvelopeShape);

export const POST = adminRoute({
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  permission: 'admin.firm.create',
  handler: async (ctx) => {
    const parsed = await parseBody(ctx.request, CreateBodyWithReauth);
    const { currentPassword, totpCode, ...input } = parsed;

    // BUG #58: password + TOTP reauth before tenant create
    // (introduces a new firm + sends invitation email to the
    // declared owner address, phishing primitive if abused).
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

    const result = await handleCreateFirm(getDeps(), ctx, input);
    return ctx.json(result, 201);
  },
});
