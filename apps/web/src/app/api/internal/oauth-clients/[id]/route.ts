/**
 * GET    /api/internal/oauth-clients/:id
 * PATCH  /api/internal/oauth-clients/:id
 * DELETE /api/internal/oauth-clients/:id
 *
 * Dashboard session auth. DELETE soft-revokes via `revoked_at` so
 * audit + consent rows keep referencing a real row; the authorize
 * endpoint's `isNull(revoked_at)` predicate keeps traffic from
 * reaching revoked clients.
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import {
  OauthClientUpdateSchema,
  handleDashboardGetOauthClient,
  handleDashboardRevokeOauthClient,
  handleDashboardUpdateOauthClient,
} from '@/server/handlers/dashboard-oauth-clients';
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

function extractId(requestUrl: string): string {
  const url = new URL(requestUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  const raw = segments[segments.length - 1] ?? '';
  return IdSchema.parse({ id: raw }).id;
}

export const GET = dashboardRoute({
  permission: 'oauth_client.read',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const id = extractId(ctx.request.url);
    const summary = await handleDashboardGetOauthClient(ctx, id);
    if (summary === null) {
      return ctx.errorJson('not_found', 'OAuth client not found.', 404);
    }
    return ctx.json(summary);
  },
});

export const PATCH = dashboardRoute({
  permission: 'oauth_client.update',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const id = extractId(ctx.request.url);
    const input = await parseBody(ctx.request, OauthClientUpdateSchema);
    const summary = await handleDashboardUpdateOauthClient(ctx, id, input);
    if (summary === null) {
      return ctx.errorJson('not_found', 'OAuth client not found.', 404);
    }
    return ctx.json(summary);
  },
});

export const DELETE = dashboardRoute({
  permission: 'oauth_client.revoke',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const id = extractId(ctx.request.url);

    // Cat 38 destructive-reauth sweep follow-up (Page 7 closure):
    // BUG #58 gated rotate-secret; revoke was missed. Soft-revoke
    // cascades to access tokens + consents, so a stolen session
    // could disconnect every customer integration with one call.
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

    const result = await handleDashboardRevokeOauthClient(ctx, id);
    if (result === 'not_found') {
      return ctx.errorJson('not_found', 'OAuth client not found.', 404);
    }
    // `already_revoked` is idempotently collapsed to 204, the
    // caller's desired end state (revoked) already holds. The
    // handler skips the audit write in that branch so the log
    // isn't polluted with duplicate revoke entries.
    return ctx.noContent();
  },
});
