/**
 * GET    /api/internal/webhooks/:id, read a webhook endpoint.
 * PATCH  /api/internal/webhooks/:id, update URL / events / active flag.
 * DELETE /api/internal/webhooks/:id, hard-delete the endpoint.
 *
 * Session-authenticated dashboard counterpart to
 * `/api/v1/webhooks/:id`. Mutations write an audit entry via the
 * shared dashboard handler so the firm's audit log names the actor
 * that pressed the button (no anonymous "webhook updated" rows).
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import {
  handleDashboardDeleteWebhook,
  handleDashboardGetWebhook,
  handleDashboardUpdateWebhook,
} from '@/server/handlers';
import { WebhookIdParams } from '@/server/handlers/_webhook-shared';
import { dashboardRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// AUD-X-THREAT-001 follow-up (BUG #57 + BUG #58): webhook UPDATE
// is the same data-exfiltration primitive as CREATE, flipping
// `url` from a legit `https://your.domain/hook` to
// `https://attacker.example.com/hook` streams every firm event to
// the attacker without ever needing the "create webhook" reauth
// gate. CREATE mints behind password+TOTP; PATCH must match.
// Mirror the envelope from `route.ts` (parent).
const UpdateWebhookEnvelope = z.object(reauthEnvelopeShape).passthrough();

/**
 * `dashboardRoute` doesn't thread Next.js path params into the
 * handler; we extract + validate the trailing `/:id` segment off the
 * request URL to match the pattern the sibling api-keys route uses.
 * Single source of format truth is {@link WebhookIdParams}, so a
 * malformed UUID short-circuits with 400 validation_failed.
 */
function extractWebhookId(requestUrl: string): string {
  const url = new URL(requestUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  const raw = segments[segments.length - 1] ?? '';
  return WebhookIdParams.parse({ id: raw }).id;
}

export const GET = dashboardRoute({
  permission: 'webhook.read',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const id = extractWebhookId(ctx.request.url);
    const summary = await handleDashboardGetWebhook(ctx, id);
    if (summary === null) {
      return ctx.errorJson('not_found', `Webhook endpoint "${id}" not found.`, 404);
    }
    return ctx.json(summary);
  },
});

export const PATCH = dashboardRoute({
  permission: 'webhook.update',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const id = extractWebhookId(ctx.request.url);

    // Two-stage parse: outer envelope pulls the destructive-reauth
    // fields for the gate; the rest passes through to
    // `handleDashboardUpdateWebhook` (its own `WebhookUpdateRequest`
    // schema validates the mutable fields). Mirrors the CREATE
    // pattern in the parent route.
    const envelope = await parseBody(ctx.request, UpdateWebhookEnvelope);

    // BUG #58: password + TOTP reauth before mutating destination
    // URL or event filter. See top of file.
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
    const result = await handleDashboardUpdateWebhook(ctx, id, body);

    if (result.status === 'not_found') {
      return ctx.errorJson('not_found', `Webhook endpoint "${id}" not found.`, 404);
    }
    if (result.status === 'url_blocked') {
      return ctx.errorJson('validation_error', result.reason, 400);
    }
    // Update can't realistically return `tier_exceeded` (no slot
    // added) or `created`/`deleted`; guard exhaustively so a future
    // handler change can't silently return a response body the
    // client can't parse.
    if (result.status !== 'updated') {
      return ctx.errorJson('internal_error', 'Unexpected mutation result.', 500);
    }

    return ctx.json(result.summary);
  },
});

export const DELETE = dashboardRoute({
  // Matrix: webhook deletion requires Admin+ (irreversible action,
  // Member can create/update but not destroy). `minRole: 'admin'`
  // replaces the legacy `'member'` that contradicted the matrix.
  permission: 'webhook.delete',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const id = extractWebhookId(ctx.request.url);

    // Cat 38 destructive-reauth sweep follow-up (Page 7 closure):
    // BUG #57+58 gated POST + PATCH; DELETE was missed. Admin+ with
    // a stolen session could silently delete webhook configurations
    //, breaking integrations + erasing the audit destination.
    const envelope = await parseBody(ctx.request, z.object(reauthEnvelopeShape));
    const authConfig = getAuthConfig();
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'firm', id: ctx.user.id },
      envelope,
      now: ctx.now,
      authConfig,
    });
    if (reauth.status === 'denied') {
      return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
    }

    const result = await handleDashboardDeleteWebhook(ctx, id);

    if (result.status === 'not_found') {
      return ctx.errorJson('not_found', `Webhook endpoint "${id}" not found.`, 404);
    }

    return ctx.noContent();
  },
});
