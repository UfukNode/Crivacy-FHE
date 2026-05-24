/**
 * POST /api/internal/admin/customers/:id/ban, ban a customer
 *
 * Requires a valid admin session with 'superadmin' role.
 *
 * Body: `{ reason?: string, notes?: string }`
 *
 * The ban orchestrator handles:
 *   - Setting customer status to 'banned'
 *   - Adding email hash to the blacklist
 *   - Revoking all active credentials (chain + DB)
 *   - Revoking all active sessions
 *   - Writing full audit trail
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { banCustomer } from '@/lib/fraud';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { notifyCustomerStatusChange } from '@/lib/notification';
import { getRootLogger } from '@/lib/observability/logger';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BanBody = z.object({
  reason: z.string().max(500).optional(),
  notes: z.string().max(2048).optional(),
});

export const POST = adminRoute({
  // Matrix: Admin+ can ban. Legacy `minRole: 'superadmin'` loosened —
  // ban is reversible via the separate `unban` endpoint (Superadmin
  // only), so Admin tier is safe for this action.
  permission: 'admin.customer.ban',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: customerId } = await params;

    // --- 1. Validate UUID format ---
    if (!UUID_V4_REGEX.test(customerId)) {
      return ctx.errorJson('validation_error', 'Invalid customer ID format.', 400);
    }

    // --- 2. Parse body envelope (reauth fields + persisted rest) ---
    const { rest, gate } = await parseDestructiveEnvelope(ctx.request);
    const body = BanBody.parse(rest);

    // --- 3. BUG #58: password + TOTP reauth before ban (irreversible
    //         lockout + blacklist hash; stolen-session destructive op) ---
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

    const reasonStr = body.reason !== undefined && body.reason.length > 0 ? body.reason : undefined;
    const notesStr = body.notes !== undefined && body.notes.length > 0 ? body.notes : undefined;

    // --- 4. Execute ban ---
    const auditContext = buildAuditRequestContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    try {
      const result = await banCustomer(ctx.db, {
        customerId,
        reason: 'manual_ban',
        source: 'admin_manual',
        bannedBy: ctx.user.id,
        notes: notesStr ?? reasonStr,
        auditContext,
      });

      // Notify customer via in-app + email
      await notifyCustomerStatusChange(ctx.db, {
        customerId,
        action: 'banned',
        reason: notesStr ?? reasonStr,
      });

      return ctx.json({
        banned: true,
        customerId,
        blacklistId: result.blacklistId,
        credentialsRevoked: result.credentialsRevoked,
        sessionsRevoked: result.sessionsRevoked,
        kycSessionsRevoked: result.kycSessionsRevoked,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ban operation failed.';
      if (message.includes('customer not found')) {
        return ctx.errorJson('not_found', 'Customer not found.', 404);
      }
      getRootLogger().error(
        {
          event: 'admin_ban_failed',
          customerId,
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        },
        'admin ban failed',
      );
      return ctx.errorJson('internal_error', 'Failed to ban customer.', 500);
    }
  },
});
