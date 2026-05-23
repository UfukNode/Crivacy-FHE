/**
 * GET /api/v1/limits, rate limit + quota state for the authenticated firm.
 *
 * Requires API key authentication with `usage:read` scope.
 */

import { handleGetLimits } from '@/server/handlers';
import { apiRoute } from '@/server/middleware/api-route';
import { authLookup } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  scopes: ['usage:read'],
  authLookup,
  handler: (ctx) => handleGetLimits(ctx),
});
