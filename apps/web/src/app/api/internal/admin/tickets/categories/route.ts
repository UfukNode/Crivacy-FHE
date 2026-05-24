/**
 * GET  /api/internal/admin/tickets/categories, list all categories (admin view)
 * POST /api/internal/admin/tickets/categories, create a new category
 *
 * GET requires at least 'support' role.
 * POST requires at least 'admin' role (manage_categories privilege).
 */

import { getAuthConfig } from '@/lib/auth/config';
import {
  handleListAdminCategories,
  handleCreateAdminCategory,
} from '@/server/handlers/tickets';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  // Listing categories is read context for ticket workflows. Anyone
  // who can read tickets needs the category list, gate with
  // `admin.ticket.read_all`.
  permission: 'admin.ticket.read_all',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    return handleListAdminCategories(ctx);
  },
});

export const POST = adminRoute({
  permission: 'admin.ticket.category_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    return handleCreateAdminCategory(ctx);
  },
});
