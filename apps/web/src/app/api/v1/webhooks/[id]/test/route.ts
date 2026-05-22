/**
 * POST /api/v1/webhooks/:id/test, send a test webhook event.
 *
 * Requires API key authentication with `webhooks:manage` scope.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';

import { handleTestWebhook } from '@/server/handlers';
import { apiRoute } from '@/server/middleware/api-route';
import { authLookup } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return apiRoute({
    scopes: ['webhooks:manage'],
    authLookup,
    handler: (ctx) =>
      handleTestWebhook(ctx, context.params as Promise<Record<string, string | string[]>>),
  })(request);
}
