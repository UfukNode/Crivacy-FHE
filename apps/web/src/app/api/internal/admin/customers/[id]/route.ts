/**
 * GET   /api/internal/admin/customers/:id, get full customer details + KYC + tickets + roles
 * PATCH /api/internal/admin/customers/:id, perform a status action on the customer
 *
 * Requires a valid admin session with at least 'admin' role.
 */

import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import {
  handleGetCustomerDetail,
  handleUpdateCustomerStatus,
} from '@/server/handlers/admin-customers';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  permission: 'admin.customer.read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleGetCustomerDetail(ctx, id);
  },
});

export const PATCH = adminRoute({
  // Status mutations, ban is `admin.customer.ban` (Admin+), unban
  // is `admin.customer.unban` (Superadmin only). Handler branches
  // on the action in the request body and enforces the right
  // permission for each branch via `ctx.permissions.has(...)`.
  // Middleware gate uses the least-privilege code so both Admin
  // (who can only ban) and Superadmin reach the handler.
  permission: 'admin.customer.ban',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const { rest, gate } = await parseDestructiveEnvelope(ctx.request);

    // BUG #58: password + TOTP reauth before status mutation
    // (suspend/activate/lock/unlock/ban/reset_kyc, every branch
    // is irreversibly user-facing).
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'admin', id: ctx.user.id },
      envelope: gate,
      now: ctx.now,
      authConfig: getAuthConfig(),
    });
    if (reauth.status === 'denied') {
      return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
    }

    return handleUpdateCustomerStatus(ctx, id, rest);
  },
});
