/**
 * GET /api/v1/usage/history, historical monthly usage.
 *
 * Requires API key authentication with `usage:read` scope.
 */

import { handleGetUsageHistory } from '@/server/handlers';
import { apiRoute } from '@/server/middleware/api-route';
import { authLookup } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  scopes: ['usage:read'],
  authLookup,
  handler: (ctx) => handleGetUsageHistory(ctx),
});
