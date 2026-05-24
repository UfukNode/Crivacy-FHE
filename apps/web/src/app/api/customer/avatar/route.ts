/**
 * POST   /api/customer/avatar, upload a new avatar image
 * DELETE /api/customer/avatar, remove the current avatar
 *
 * Requires a valid customer session.
 */


import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleUploadAvatar, handleDeleteAvatar } from '@/server/handlers/customer-profile';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export const POST = customerRoute({
  handler: async (ctx) => {
    // Per-IP cap, avatar upload is the most expensive write on the
    // customer surface (2 MiB request body + sharp CPU for resize +
    // re-encode). 10/15min keeps legitimate "try a different photo"
    // retries comfortable while shutting down a CPU-burning spam loop.
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'customer_avatar_upload',
      ctx.ip,
      ctx.now,
    );
    if (limited) return limited;
    return handleUploadAvatar(ctx);
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});

export const DELETE = customerRoute({
  handler: async (ctx) => {
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'customer_avatar_delete',
      ctx.ip,
      ctx.now,
    );
    if (limited) return limited;
    return handleDeleteAvatar(ctx);
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
