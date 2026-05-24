/**
 * POST /api/customer/kyc/handoff
 *
 * Generates a one-time device handoff token for the customer's active KYC
 * session. Returns a QR code data URL and the handoff URL so the customer
 * can continue verification on a mobile device.
 *
 * Requires a valid customer session (JWT auth via customerRoute).
 */


import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleCreateHandoff } from '@/server/handlers/customer-kyc';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST = customerRoute({
  handler: handleCreateHandoff,
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
