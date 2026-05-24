/**
 * GET  /api/internal/tickets, list tickets for the caller's firm (team inbox).
 * POST /api/internal/tickets, create a new firm ticket.
 *
 * Authenticated firm-user endpoints. Team visibility means every
 * active firm_user of the same firm sees every firm ticket.
 */

import { getAuthConfig } from '@/lib/auth/config';
import {
  handleCreateFirmTicket,
  handleListFirmTickets,
} from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = dashboardRoute({
  // Firm-wide ticket list is "team inbox", Admin+ see all firm
  // tickets; Member/Viewer see only their own tickets via a
  // separate `ticket.read.own` surface. Matrix: `ticket.read.firm`
  // is Admin+ territory.
  permission: 'ticket.read.firm',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: (ctx) => handleListFirmTickets(ctx),
});

export const POST = dashboardRoute({
  permission: 'ticket.create',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: (ctx) => handleCreateFirmTicket(ctx),
});
