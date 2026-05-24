/**
 * DELETE /api/customer/sessions/[id]
 *
 * Revoke a specific customer session by ID. The session must belong to the
 * authenticated customer. The current session cannot be revoked through this
 * endpoint (use logout instead).
 *
 * Sets `revoked_at` and `revoked_reason = 'user_revoked'`.
 * Writes an audit entry: `customer.session.revoked`.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { parsePathParams } from '@/server/middleware/parse';

import { writeAudit } from '@/lib/audit/writer';
import { customerActor, customerLabel } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PathParams = z.object({
  id: z.string().uuid(),
});
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: targetSessionId } = await parsePathParams(params, PathParams);

  return customerRoute({
    authConfig: getAuthConfig,
    sessionLookup: lookupCustomerSession,
    customerLookup: lookupCustomer,
    dbFactory: () => getDatabaseClient().db,
    handler: async (ctx) => {
      const db = ctx.db;
      const now = ctx.now;
      const customerId = ctx.customer.id;
      const currentSessionId = ctx.session.sessionId;

      // --- 1. Cannot revoke current session ---
      if (targetSessionId === currentSessionId) {
        return ctx.errorJson(
          'validation_failed',
          'Cannot revoke the current session. Use logout instead.',
          400,
        );
      }

      // --- 2. Verify session exists and belongs to this customer ---
      const sessionResult = await db.execute<{
        id: string;
        customer_id: string;
        revoked_at: string | null;
      }>(
        sql`SELECT id, customer_id, revoked_at::text
         FROM customer_sessions
         WHERE id = ${targetSessionId}
         LIMIT 1`,
      );
      const targetRow = sessionResult.rows[0] as {
        id: string;
        customer_id: string;
        revoked_at: string | null;
      } | undefined;

      if (!targetRow || targetRow.customer_id !== customerId) {
        return ctx.errorJson('not_found', 'Session not found.', 404);
      }

      if (targetRow.revoked_at !== null) {
        return ctx.errorJson('conflict', 'Session is already revoked.', 409);
      }

      // --- 3. Revoke ---
      await db.execute(
        sql`UPDATE customer_sessions
         SET revoked_at = ${now.toISOString()}, revoked_reason = 'user_revoked'
         WHERE id = ${targetSessionId} AND revoked_at IS NULL`,
      );

      // --- 4. Audit ---
      const auditCtx = buildAuditContext({
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      await writeAudit(db, {
        action: 'customer.session.revoked',
        actor: customerActor({ id: customerId, label: customerLabel(ctx.customer) }),
        target: noTarget(),
        context: auditCtx,
        meta: {
          revokedSessionId: targetSessionId,
          reason: 'user_revoked',
        },
        ts: now,
      });

      return ctx.json({ message: 'Session revoked.' });
    },
  })(request);
}
