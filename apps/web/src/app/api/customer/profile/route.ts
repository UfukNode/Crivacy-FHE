/**
 * GET   /api/customer/profile, return full profile with mutability metadata
 * PATCH /api/customer/profile, update editable fields (displayName, phone)
 *
 * Requires a valid customer session.
 */


import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleGetProfile, handleUpdateProfile } from '@/server/handlers/customer-profile';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export const GET = customerRoute({
  handler: handleGetProfile,
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});

export const PATCH = customerRoute({
  handler: async (ctx) => {
    // Per-IP cap, a stolen-session attacker could otherwise spam
    // profile writes to flood the audit trail or thrash the phone-
    // unique index. 30/15min is the "definitely human" floor.
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'customer_profile_update',
      ctx.ip,
      ctx.now,
    );
    if (limited) return limited;
    return handleUpdateProfile(ctx);
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
