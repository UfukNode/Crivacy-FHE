/**
 * GET /api/internal/admin/customers/:id/avatar, serve a customer's avatar (admin only).
 *
 * Mirrors the customer-facing avatar endpoint but authorised via an admin
 * session. Returns the WebP image with `Cache-Control: private, no-store`
 * so sensitive imagery never enters a shared cache. All admin roles (support
 * and above) may read avatars; no mutation is possible here.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleServeCustomerAvatar } from '@/server/handlers/admin-customers';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  // Avatar read is customer data view, gated under `admin.customer.read`
  // (Support+). Separate `admin.customer.avatar_upload` permission
  // covers mutations (not exposed by this route).
  permission: 'admin.customer.read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleServeCustomerAvatar(ctx, id);
  },
});
