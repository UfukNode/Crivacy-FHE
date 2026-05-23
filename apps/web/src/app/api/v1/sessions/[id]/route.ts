/**
 * /api/v1/sessions/:id, read (GET) and cancel (DELETE) a KYC session.
 *
 * Both methods require API key authentication. The `id` path param is
 * captured by Next.js App Router and forwarded to the handler.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';

import { handleCancelSession, handleGetSession } from '@/server/handlers';
import { apiRoute } from '@/server/middleware/api-route';
import { authLookup } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return apiRoute({
    scopes: ['kyc:read'],
    authLookup,
    handler: (ctx) =>
      handleGetSession(ctx, context.params as Promise<Record<string, string | string[]>>),
  })(request);
}

export function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return apiRoute({
    scopes: ['kyc:create'],
    authLookup,
    handler: (ctx) =>
      handleCancelSession(ctx, context.params as Promise<Record<string, string | string[]>>),
  })(request);
}
