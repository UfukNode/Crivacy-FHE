/**
 * POST /api/internal/api-keys/:id/rotate, rotate an API key
 *
 * Permission policy mirrors DELETE: caller needs `api_key.rotate.own`;
 * callers without `api_key.rotate.any` can only rotate keys they
 * created themselves (handler-level ownership check).
 */

import { z } from 'zod';

import { RbacError } from '@/lib/rbac/errors';
import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { handleRotateApiKey } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  countActiveApiKeysByFirm,
  findApiKeyCreatorId,
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamSchema = z.object({
  id: z.string().uuid(),
});

// AUD-X-THREAT-001 + BUG #58: rotate mints a new raw key and
// invalidates the old, a stolen session would silently hijack
// API access without the destructive-reauth envelope.
const RotateApiKeyBody = z.object(reauthEnvelopeShape);

function getDeps() {
  const cfg = getAuthConfig();
  return {
    authConfig: { apiKeyBcryptCost: cfg.apiKeyBcryptCost },
    listKeys: listApiKeys,
    countActiveKeys: countActiveApiKeysByFirm,
    insertKey: insertApiKey,
    revokeKey: revokeApiKey,
    rotateKey: rotateApiKey,
  };
}

export const POST = dashboardRoute({
  permission: 'api_key.rotate.own',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const segments = url.pathname.split('/');
    // pathname = /api/internal/api-keys/{id}/rotate
    // segments = ['', 'api', 'internal', 'api-keys', '{id}', 'rotate']
    const rawId = segments[segments.length - 2] ?? '';
    const params = ParamSchema.parse({ id: rawId });

    const body = await parseBody(ctx.request, RotateApiKeyBody);

    // BUG #58: password + TOTP reauth before rotation. See
    // api-keys POST for full rationale.
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

    // Ownership gate, identical to the DELETE endpoint. Member-
    // tier callers rotating someone else's key would effectively
    // invalidate the original without the creator's consent; the
    // `.any` check below rubber-stamps Admin+ and blocks others.
    if (!ctx.permissions.has('api_key.rotate.any')) {
      const creatorId = await findApiKeyCreatorId(ctx.db, ctx.firm.id, params.id);
      if (creatorId !== ctx.user.id) {
        throw new RbacError(
          'permission_denied',
          'You can only rotate API keys you created. Ask an admin to rotate keys created by others.',
        );
      }
    }

    const result = await handleRotateApiKey(getDeps(), ctx, params.id);
    if (result === null) {
      // BUG #43 fix: rotate against a cross-firm or non-existent UUID
      // used to mint a fresh `crv_live_*` rawKey and return it as if
      // the rotation had happened. The actual UPDATE affected zero
      // rows (firm_id WHERE clause), so the issued key was never
      // hashed into the DB and could not authenticate, but the
      // response body lied. Surface the miss as 404 instead.
      return ctx.errorJson('not_found', 'API key not found.', 404);
    }
    return ctx.json(result);
  },
});
