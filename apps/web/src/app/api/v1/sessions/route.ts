/**
 * /api/v1/sessions, create (POST) and list (GET) KYC sessions.
 *
 * Both methods require API key authentication:
 *   - POST: `kyc:create` scope
 *   - GET:  `kyc:read` scope (list)
 */

import { handleCreateSession, handleListSessions } from '@/server/handlers';
import { apiRoute } from '@/server/middleware/api-route';
import { authLookup } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  scopes: ['kyc:create'],
  authLookup,
  handler: (ctx) => handleCreateSession(ctx),
});

export const GET = apiRoute({
  scopes: ['kyc:read'],
  authLookup,
  handler: (ctx) => handleListSessions(ctx),
});
