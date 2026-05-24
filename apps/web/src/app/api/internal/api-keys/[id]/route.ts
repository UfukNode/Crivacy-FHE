/**
 * DELETE /api/internal/api-keys/:id, revoke an API key
 *
 * Permission policy:
 *  * Caller needs at minimum `api_key.revoke.own` (Member+).
 *  * If the key was not created by the caller AND they lack
 *    `api_key.revoke.any`, we deny with 403, Member can only
 *    revoke keys they created themselves.
 *  * Admin+ holds `.any`, bypassing the ownership check.
 */

import { z } from 'zod';

import { RbacError } from '@/lib/rbac/errors';
import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { handleDeleteApiKey } from '@/server/handlers';
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

export const DELETE = dashboardRoute({
  // Least-privilege middleware gate. `api_key.revoke.own` is the
  // minimum any caller can hold; Admin+ also carries `.any` which
  // the handler uses to skip the ownership check.
  permission: 'api_key.revoke.own',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const segments = url.pathname.split('/');
    const rawId = segments[segments.length - 1] ?? '';
    const params = ParamSchema.parse({ id: rawId });

    // Cat 38 destructive-reauth sweep follow-up (Page 7 closure):
    // BUG #58 covered POST + rotate; DELETE was missed. A stolen
    // session can otherwise revoke API keys silently, DoSes every
    // integration this firm runs.
    const envelope = await parseBody(ctx.request, z.object(reauthEnvelopeShape));
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'firm', id: ctx.user.id },
      envelope,
      now: ctx.now,
      authConfig: getAuthConfig(),
    });
    if (reauth.status === 'denied') {
      return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
    }

    // Ownership gate: callers without `api_key.revoke.any` can only
    // revoke keys they personally created. Cross-user revokes from
    // Members would otherwise let any teammate invalidate someone
    // else's credentials without audit-visible justification.
    if (!ctx.permissions.has('api_key.revoke.any')) {
      const creatorId = await findApiKeyCreatorId(ctx.db, ctx.firm.id, params.id);
      if (creatorId !== ctx.user.id) {
        throw new RbacError(
          'permission_denied',
          'You can only revoke API keys you created. Ask an admin to revoke keys created by others.',
        );
      }
    }

    const revoked = await handleDeleteApiKey(getDeps(), ctx, params.id);
    if (!revoked) {
      // BUG #43 fix: surface cross-firm or non-existent UUIDs as 404
      // instead of a misleading 204. Without this every firm could
      // probe another firm's key existence by attempting DELETE.
      return ctx.errorJson('not_found', 'API key not found.', 404);
    }
    return ctx.noContent();
  },
});
