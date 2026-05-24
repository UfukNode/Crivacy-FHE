/**
 * GET /api/internal/admin/customers, list customers with search, filters, pagination
 *
 * Requires a valid admin session with at least 'admin' role.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleListCustomers } from '@/server/handlers/admin-customers';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  // Matrix: Support+ can read customers (common support task).
  // Legacy `minRole: 'admin'` loosened.
  permission: 'admin.customer.read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    return handleListCustomers(ctx);
  },
});
