/**
 * /api/v1/webhooks/:id, read (GET), update (PATCH), delete (DELETE)
 * a webhook subscription.
 *
 * All methods require API key authentication.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';

import { handleDeleteWebhook, handleGetWebhook, handleUpdateWebhook } from '@/server/handlers';
import { apiRoute } from '@/server/middleware/api-route';
import { authLookup } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return apiRoute({
    scopes: ['webhooks:manage'],
    authLookup,
    handler: (ctx) =>
      handleGetWebhook(ctx, context.params as Promise<Record<string, string | string[]>>),
  })(request);
}

export function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return apiRoute({
    scopes: ['webhooks:manage'],
    authLookup,
    handler: (ctx) =>
      handleUpdateWebhook(ctx, context.params as Promise<Record<string, string | string[]>>),
  })(request);
}

export function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return apiRoute({
    scopes: ['webhooks:manage'],
    authLookup,
    handler: (ctx) =>
      handleDeleteWebhook(ctx, context.params as Promise<Record<string, string | string[]>>),
  })(request);
}
