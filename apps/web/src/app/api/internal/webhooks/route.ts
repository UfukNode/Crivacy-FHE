/**
 * GET  /api/internal/webhooks, list the firm's webhook endpoints.
 * POST /api/internal/webhooks, create a new webhook endpoint.
 *
 * Session-authenticated counterpart to the public `/api/v1/webhooks`
 * surface. Both sides reuse the same repository functions, validation
 * schemas, and response DTO via `_webhook-shared`, so the dashboard
 * UI and API consumers never see diverging shapes.
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { PaginationQuery } from '@/lib/openapi/common/pagination';
import {
  handleDashboardCreateWebhook,
  handleDashboardListWebhooks,
} from '@/server/handlers';
import { decodeWebhookCursor } from '@/server/handlers/_webhook-shared';
import { dashboardRoute } from '@/server/middleware';
import { parseBody, parseQuery } from '@/server/middleware/parse';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// AUD-X-THREAT-001 + BUG #58: webhook create is a data-
// exfiltration primitive, registering
// `https://attacker.example.com/hook` streams every firm event
// (credential.created, consent.granted, ticket.updated, …) to
// the attacker. Require password + TOTP reauth. The webhook body
// schema stays in `_webhook-shared`; we pick off the envelope at
// the outer parse and pass the rest through.
const CreateWebhookEnvelope = z.object(reauthEnvelopeShape).passthrough();

export const GET = dashboardRoute({
  permission: 'webhook.read',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const query = parseQuery(new URL(ctx.request.url), PaginationQuery);
    const cursor = query.cursor !== undefined ? decodeWebhookCursor(query.cursor) : null;

    const opts: { cursor?: { ts: Date; id: string }; limit?: number } = {};
    if (cursor !== null) opts.cursor = cursor;
    if (query.limit !== undefined) opts.limit = query.limit;

    const result = await handleDashboardListWebhooks(ctx, opts);
    return ctx.json(result);
  },
});

export const POST = dashboardRoute({
  // Mirror the role gate the public API enforces via scopes. Only
  // members and above may mutate firm state from the dashboard; a
  // viewer cannot create webhook subscriptions here either.
  permission: 'webhook.create',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    // Two-stage parse: outer envelope pulls the destructive-reauth
    // fields off for the gate, the rest falls through to
    // `handleDashboardCreateWebhook` where `WebhookCreateRequest`
    // validates the persisted fields. `passthrough()` keeps the
    // non-envelope keys accessible.
    const envelope = await parseBody(ctx.request, CreateWebhookEnvelope);

    // BUG #58: password + TOTP reauth before creation.
    const authConfig = getAuthConfig();
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'firm', id: ctx.user.id },
      envelope: {
        currentPassword: envelope.currentPassword,
        totpCode: envelope.totpCode,
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
      ...body
    } = envelope;
    const result = await handleDashboardCreateWebhook(ctx, body);

    if (result.status === 'tier_exceeded') {
      return ctx.errorJson(
        'tier_forbidden',
        `Your ${result.tier} tier allows at most ${String(result.maxSlots)} webhook subscriptions.`,
        403,
      );
    }
    if (result.status === 'url_blocked') {
      return ctx.errorJson('validation_error', result.reason, 400);
    }
    if (result.status !== 'created') {
      // The handler's mutation union also includes `updated /
      // deleted / not_found` for reuse by other surfaces; none of
      // those are reachable from this create path, but a future
      // refactor could re-surface one. 500 so the client sees
      // a clean "something changed upstream" signal.
      return ctx.errorJson('internal_error', 'Unexpected mutation result.', 500);
    }

    return ctx.json({ ...result.summary, secret: result.secret }, 201);
  },
});
