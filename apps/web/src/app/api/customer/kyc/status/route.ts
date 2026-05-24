/**
 * GET /api/customer/kyc/status
 *
 * Returns the customer's current KYC level, score, recent sessions,
 * and credential status. Requires a valid customer session.
 */


import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleGetKycStatus } from '@/server/handlers/customer-kyc';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const GET = customerRoute({
  handler: handleGetKycStatus,
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
