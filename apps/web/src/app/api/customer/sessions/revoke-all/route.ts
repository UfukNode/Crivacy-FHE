/**
 * POST /api/customer/sessions/revoke-all
 *
 * Revoke all customer sessions EXCEPT the current one. This is the
 * "sign out everywhere else" action.
 *
 * Sets `revoked_at` and `revoked_reason = 'user_revoked_all'` on every
 * matching row.
 *
 * Writes an audit entry: `customer.session.revoked_all`.
 */

import { sql } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';

import { writeAudit } from '@/lib/audit/writer';
import { customerActor, customerLabel } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
  handler: async (ctx) => {
    const db = ctx.db;
    const now = ctx.now;
    const customerId = ctx.customer.id;
    const currentSessionId = ctx.session.sessionId;

    // --- 1. Revoke all sessions except current ---
    const revokeResult = await db.execute<{ id: string }>(
      sql`UPDATE customer_sessions
       SET revoked_at = ${now.toISOString()}, revoked_reason = 'user_revoked_all'
       WHERE customer_id = ${customerId}
         AND id != ${currentSessionId}
         AND revoked_at IS NULL
       RETURNING id`,
    );
    const revokedCount = revokeResult.rows.length;

    // --- 2. Audit ---
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
    await writeAudit(db, {
      action: 'customer.session.revoked_all',
      actor: customerActor({ id: customerId, label: customerLabel(ctx.customer) }),
      target: noTarget(),
      context: auditCtx,
      meta: {
        keptSessionId: currentSessionId,
        revokedCount,
      },
      ts: now,
    });

    return ctx.json({ message: 'All other sessions revoked.', revokedCount });
  },
});
