/**
 * POST /api/internal/oauth-clients/:id/rotate-secret, issue a new
 * client_secret and hash the old one out of the DB. Raw secret is
 * returned once in the response body; every subsequent read shows
 * the masked placeholder.
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { handleDashboardRotateOauthClientSecret } from '@/server/handlers/dashboard-oauth-clients';
import { dashboardRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IdSchema = z.object({ id: z.string().uuid() });

// AUD-X-THREAT-001 + BUG #58: rotate-secret is a reveal-once
// operation, the raw client_secret comes back in the response
// body. A stolen session that reaches this endpoint captures the
// new secret and can impersonate the firm's OAuth client against
// customers. Require password + TOTP reauth.
const RotateSecretBody = z.object(reauthEnvelopeShape);

export const POST = dashboardRoute({
  permission: 'oauth_client.rotate_secret',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    // Extract + validate the id from the URL (the dashboardRoute
    // builder doesn't thread Next.js path params into the handler).
    const url = new URL(ctx.request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    // /api/internal/oauth-clients/:id/rotate-secret → id at -2
    const raw = segments[segments.length - 2] ?? '';
    const { id } = IdSchema.parse({ id: raw });

    const body = await parseBody(ctx.request, RotateSecretBody);

    // BUG #58: password + TOTP reauth before rotating.
    const authConfig = getAuthConfig();
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'firm', id: ctx.user.id },
      envelope: {
        currentPassword: body.currentPassword,
        totpCode: body.totpCode,
      },
      now: ctx.now,
      authConfig,
    });
    if (reauth.status === 'denied') {
      return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
    }

    const result = await handleDashboardRotateOauthClientSecret(ctx, id);
    if (result === null) {
      return ctx.errorJson('not_found', 'OAuth client not found.', 404);
    }
    return ctx.json(result);
  },
});
