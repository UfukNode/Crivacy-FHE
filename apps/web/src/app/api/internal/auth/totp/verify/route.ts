/**
 * POST /api/internal/auth/totp/verify
 *
 * Verify a TOTP code during enrollment. On success, encrypts and
 * persists the secret.
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { handleTotpVerify } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
  saveTotpSecret,
} from '@/server/repositories';

import { totpCodeSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TotpVerifyBody = z.object({
  secret: z.string().min(1),
  code: totpCodeSchema,
});

export const POST = dashboardRoute({
  permission: 'profile.totp_manage',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const body = await parseBody(ctx.request, TotpVerifyBody);

    await handleTotpVerify(
      {
        db: ctx.db,
        authConfig: getAuthConfig(),
        saveTotpSecret,
      },
      {
        userId: ctx.user.id,
        secret: body.secret,
        code: body.code,
      },
    );

    return ctx.json({ verified: true });
  },
});
