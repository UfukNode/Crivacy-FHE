/**
 * GET /api/customer/kyc/callback-status?session=<diditSessionId>
 *
 * Sprint 9: real-state callback variant resolver. The `/kyc/callback`
 * page polls this endpoint after Didit redirects, instead of
 * trusting the URL `?status=` query parameter (which is fully
 * attacker-controllable). Returns the registry-resolved variant
 * keyed off the actual `kyc_sessions` row + opportunistically pulls
 * Didit when the row is non-terminal, closing the webhook-401 drift
 * gap.
 *
 * Requires a customer session cookie. Phone-handoff landings (no
 * cookie) get a 401 and the page falls back to a neutral
 * "submitted" variant.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleCallbackStatus } from '@/server/handlers/customer-kyc';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = customerRoute({
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const diditSessionId = url.searchParams.get('session') ?? '';
    return handleCallbackStatus(ctx, diditSessionId);
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
