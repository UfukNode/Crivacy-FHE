/**
 * GET  /api/internal/oauth-clients, list the firm's OAuth clients.
 * POST /api/internal/oauth-clients, create a new OAuth client.
 *
 * Dashboard session auth. Create response includes the raw
 * `client_secret` exactly once, every subsequent read returns the
 * masked placeholder.
 */

import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import {
  OauthClientCreateSchema,
  handleDashboardCreateOauthClient,
  handleDashboardListOauthClients,
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

// AUD-X-THREAT-001 + BUG #58: local body schema extends
// `OauthClientCreateSchema` with the destructive-reauth envelope
// (currentPassword + totpCode). The shared schema still describes
// the persisted fields alone.
const CreateOauthClientBody = OauthClientCreateSchema.extend(reauthEnvelopeShape);

export const GET = dashboardRoute({
  permission: 'oauth_client.read',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const clients = await handleDashboardListOauthClients(ctx);
    // `{ data, pagination }` envelope standard, AUD-X-ENVELOPE-001.
    // OAuth clients list tier-capped, cursor yok; nextCursor=null.
    return ctx.json({ data: clients, pagination: { nextCursor: null, limit: clients.length } });
  },
});

export const POST = dashboardRoute({
  // Admin role or higher, matches the api-key create gate. Viewers
  // must not be able to mint OAuth clients on behalf of the firm.
  permission: 'oauth_client.create',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const body = await parseBody(ctx.request, CreateOauthClientBody);

    // BUG #58: password + TOTP reauth before minting a new OAuth
    // client. Creating a client plus the subsequent secret reveal
    // gives an attacker enough to impersonate the firm's app in
    // front of customers, classic phishing consent-page vector.
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

    const {
      currentPassword: _omitPwd,
      totpCode: _omitTotp,
      ...input
    } = body;
    const result = await handleDashboardCreateOauthClient(ctx, input);
    if (result.status === 'tier_exceeded') {
      return ctx.errorJson(
        'tier_forbidden',
        `Your ${result.tier} tier allows at most ${String(result.maxSlots)} OAuth client${
          result.maxSlots === 1 ? '' : 's'
        }. Upgrade to register more.`,
        403,
      );
    }
    return ctx.json(
      { summary: result.summary, clientSecret: result.clientSecret },
      201,
    );
  },
});
