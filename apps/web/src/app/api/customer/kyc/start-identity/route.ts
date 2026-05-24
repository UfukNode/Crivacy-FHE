/**
 * POST /api/customer/kyc/start-identity
 *
 * Creates a Didit identity verification session (phase 1: ID document +
 * liveness + face match). Returns a redirect URL to the Didit hosted flow.
 * Requires a valid customer session with 'active' status.
 *
 * Optional body: `{ continueUrl?: string }`, same-origin path
 * (`/path/...`) the `/kyc/callback` page should redirect to once the
 * verdict arrives (Sprint 9). Used so a `/kyc?continue=...`
 * landing carries its post-completion target through to the
 * callback. Sanitised at the handler entry; non-same-origin values
 * become null.
 */


import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleStartIdentity } from '@/server/handlers/customer-kyc';
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
    // Per-customer cap, each call mints a Didit session (billed
    // upstream). 5/min sits well above any human "clicked twice"
    // pattern while stopping a scripted spam that would both cost
    // money and blow up the `kyc_sessions` table.
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'kyc_start',
      ctx.customer.id,
      ctx.now,
    );
    if (limited !== null) return limited;

    // Body is optional. A bare POST (e.g. legacy clients) gets
    // continueUrl=null and falls through unchanged. parseBody
    // failures (invalid JSON, schema violation) are swallowed into
    // null on this surface, the start path is otherwise the same.
    let continueUrl: string | null = null;
    try {
      const body = await parseBody(ctx.request, Body);
      if (typeof body.continueUrl === 'string') {
        continueUrl = body.continueUrl;
      }
    } catch {
      // Ignore, leave continueUrl as null.
    }

    return handleStartIdentity(ctx, continueUrl);
  },
});
