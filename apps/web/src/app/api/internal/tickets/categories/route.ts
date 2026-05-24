/**
 * GET /api/internal/tickets/categories, categories firm users can open
 * tickets in (audience = 'firm' or 'any', active only).
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleListFirmTicketCategories } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = dashboardRoute({
  // Reading the list of categories is part of ticket creation flow —
  // anyone who can create a ticket needs this. Gate with `ticket.create`
  // so viewer-tier (no create) does not see the picker either.
  permission: 'ticket.create',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: (ctx) => handleListFirmTicketCategories(ctx),
});
