/**
 * GET /api/internal/firm, get firm profile + settings
 * PATCH /api/internal/firm, update firm profile
 */

import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { handleGetFirmProfile, handleUpdateFirmProfile } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findFirmByIdForMiddleware,
  findFirmProfile,
  findFirmSettings,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
  updateFirm,
} from '@/server/repositories';

import { emailSchema } from '@/lib/validation/auth';
import { firmNameSchema } from '@/lib/validation/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FirmUpdateBody = z
  .object({
    name: firmNameSchema.optional(),
    contactEmail: emailSchema.optional(),
    billingEmail: emailSchema.optional(),
    supportUrl: z.string().url().max(2048).optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.contactEmail !== undefined ||
      data.billingEmail !== undefined ||
      data.supportUrl !== undefined,
    { message: 'At least one field must be provided' },
  );

export const GET = dashboardRoute({
  permission: 'firm.read',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const result = await handleGetFirmProfile(
      { findFirmProfile, findFirmSettings, updateFirm },
      ctx,
    );
    return ctx.json(result);
  },
});

export const PATCH = dashboardRoute({
  permission: 'firm.update',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    // Per-IP cap, a stolen firm-admin session could otherwise spam
    // profile writes to flood the audit stream.
    const limited = await maybeRateLimitResponse(ctx.db, 'firm_profile_update', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(ctx.request, FirmUpdateBody);
    // Use conditional spread to avoid `exactOptionalPropertyTypes` mismatch
    // (Zod .optional() emits `string | undefined`; the handler interface
    // expects the property absent or `string`, never `undefined`).
    const input = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.contactEmail !== undefined ? { contactEmail: body.contactEmail } : {}),
      ...(body.billingEmail !== undefined ? { billingEmail: body.billingEmail } : {}),
      ...(body.supportUrl !== undefined ? { supportUrl: body.supportUrl } : {}),
    };
    const result = await handleUpdateFirmProfile(
      { findFirmProfile, findFirmSettings, updateFirm },
      ctx,
      input,
    );
    return ctx.json(result);
  },
});
