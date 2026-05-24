/**
 * POST /api/customer/kyc/start-address
 *
 * Creates a Didit address verification session (phase 2: proof of address).
 * Requires identity + biometric verification to be completed first (kyc_3+).
 * Returns a redirect URL to the Didit hosted flow.
 *
 * Optional body: `{ continueUrl?: string }`, same-origin path the
 * `/kyc/callback` page should redirect to once the verdict arrives.
 * Mirrors the start-identity contract; sanitised at the handler.
 */


import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleStartAddress } from '@/server/handlers/customer-kyc';
import { parseBody } from '@/server/middleware/parse';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z
  .object({
    continueUrl: z.string().min(1).max(2048).optional(),
  })
  .partial();

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
  handler: async (ctx) => {
    // Same `kyc_start` policy as start-identity: per-customer, 5/min,
    // capped because every call creates an upstream Didit session
    // (billed) and there is no legitimate reason to retry this fast.
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'kyc_start',
      ctx.customer.id,
      ctx.now,
    );
    if (limited !== null) return limited;

    let continueUrl: string | null = null;
    try {
      const body = await parseBody(ctx.request, Body);
      if (typeof body.continueUrl === 'string') {
        continueUrl = body.continueUrl;
      }
    } catch {
      // Ignore, leave continueUrl as null.
    }

    return handleStartAddress(ctx, continueUrl);
  },
});
