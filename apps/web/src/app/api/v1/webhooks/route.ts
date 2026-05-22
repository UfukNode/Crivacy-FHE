/**
 * /api/v1/webhooks, list (GET) and create (POST) webhook subscriptions.
 *
 * Both methods require API key authentication with `webhooks:manage` scope.
 */

import { handleCreateWebhook, handleListWebhooks } from '@/server/handlers';
import { apiRoute } from '@/server/middleware/api-route';
import { authLookup } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  scopes: ['webhooks:manage'],
  authLookup,
  handler: (ctx) => handleListWebhooks(ctx),
});

export const POST = apiRoute({
  scopes: ['webhooks:manage'],
  authLookup,
  handler: (ctx) => handleCreateWebhook(ctx),
});
