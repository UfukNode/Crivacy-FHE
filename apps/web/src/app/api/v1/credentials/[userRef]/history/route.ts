/**
 * GET /api/v1/credentials/:userRef/history, credential lifecycle history.
 *
 * Requires API key authentication with `kyc:read` scope.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';

import { handleGetCredentialHistory } from '@/server/handlers';
import { apiRoute } from '@/server/middleware/api-route';
import { authLookup } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(
  request: NextRequest,
  context: { params: Promise<{ userRef: string }> },
): Promise<NextResponse> {
  return apiRoute({
    scopes: ['kyc:read'],
    authLookup,
    handler: (ctx) =>
      handleGetCredentialHistory(ctx, context.params as Promise<Record<string, string | string[]>>),
  })(request);
}
