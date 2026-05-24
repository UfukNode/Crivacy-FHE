/**
 * POST /api/customer/erasure
 *
 * GDPR Article 17, irreversibly anonymize the caller's account.
 * See `customer-erasure.ts` for the full cascade. Rate-limited to
 * 3/day (a legit customer runs this once; higher ceiling covers
 * retry after a transient 5xx).
 */

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleCustomerErasure } from '@/server/handlers/customer-erasure';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = customerRoute({
  handler: async (ctx) => {
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'customer_erasure',
      ctx.ip,
      ctx.now,
    );
    if (limited) return limited;
    return handleCustomerErasure(ctx);
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
