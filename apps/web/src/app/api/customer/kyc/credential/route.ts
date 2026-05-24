/**
 * GET /api/customer/kyc/credential
 *
 * Returns a summary of the customer's KYC credential derived from their
 * current verification level and score. Used by the credential card
 * component in the customer dashboard.
 */


import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleGetCredential } from '@/server/handlers/customer-kyc';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const GET = customerRoute({
  handler: handleGetCredential,
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
