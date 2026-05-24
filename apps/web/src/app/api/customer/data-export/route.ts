/**
 * GET /api/customer/data-export
 *
 * GDPR Article 15 + 20, return every row Crivacy stores about the
 * caller as a downloadable JSON file. Audited via
 * `compliance.data_exported`. Rate-limited (3/day) to cap abuse.
 */

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleCustomerDataExport } from '@/server/handlers/customer-data-export';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = customerRoute({
  handler: async (ctx) => {
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'customer_data_export',
      ctx.ip,
      ctx.now,
    );
    if (limited) return limited;
    return handleCustomerDataExport(ctx);
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
