/**
 * POST /api/v1/credentials/verify, verify a credential disclosure blob.
 *
 * Requires API key authentication with `kyc:verify` scope.
 */

import { handleVerifyCredential } from '@/server/handlers';
import { apiRoute } from '@/server/middleware/api-route';
import { authLookup } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  scopes: ['kyc:verify'],
  authLookup,
  handler: (ctx) => handleVerifyCredential(ctx),
});
