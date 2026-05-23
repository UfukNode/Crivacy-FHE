/**
 * GET /api/v1/usage, current billing period usage summary.
 *
 * Requires API key authentication with `usage:read` scope.
 */

import { handleGetUsage } from '@/server/handlers';
import { apiRoute } from '@/server/middleware/api-route';
import { authLookup } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  scopes: ['usage:read'],
  authLookup,
  handler: (ctx) => handleGetUsage(ctx),
});
