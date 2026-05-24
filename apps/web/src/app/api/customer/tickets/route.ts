/**
 * GET  /api/customer/tickets, list customer's tickets
 * POST /api/customer/tickets, create a new ticket
 *
 * Requires a valid customer session.
 */


import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleListCustomerTickets, handleCreateCustomerTicket } from '@/server/handlers/tickets';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export const GET = customerRoute({
  handler: handleListCustomerTickets,
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});

export const POST = customerRoute({
  handler: handleCreateCustomerTicket,
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
