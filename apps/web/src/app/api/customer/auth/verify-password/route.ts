/**
 * POST /api/customer/auth/verify-password
 *
 * Re-authentication endpoint, verify the customer's password without
 * creating a new session. Used by the reauth dialog for sensitive actions
 * (session revocation, email change, credential revocation, etc.).
 *
 * Rate limited to 5 attempts per 15 minutes per customer. After the limit
 * is exceeded the endpoint returns 429 until the window expires.
 *
 * Returns 200 on success, 401 on wrong password, 429 on rate limit.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { verifyPassword } from '@/lib/auth/password';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseBody } from '@/server/middleware/parse';

import { writeAudit } from '@/lib/audit/writer';
import { customerActor, customerLabel } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';
import { existingPasswordSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Maximum verify-password attempts per customer within the rate-limit window. */
const MAX_ATTEMPTS = 5;

/** Rate-limit window in minutes. */
const WINDOW_MINUTES = 15;

const VerifyPasswordBody = z.object({
  password: existingPasswordSchema,
});
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

    // --- 1. Parse body ---
    const body = await parseBody(ctx.request, VerifyPasswordBody);

    // --- 2. Rate limit check: count attempts in the last WINDOW_MINUTES ---
    const windowStart = new Date(now.getTime() - WINDOW_MINUTES * 60 * 1000);
    const countResult = await db.execute<{ cnt: number }>(
      sql`SELECT count(*)::int AS cnt
       FROM audit_log
       WHERE action IN ('customer.reauth.success', 'customer.reauth.failed')
         AND actor_id = ${customerId}
         AND ts >= ${windowStart.toISOString()}`,
    );
    const countRow = countResult.rows[0] as { cnt: number } | undefined;
    const attemptCount = countRow?.cnt ?? 0;

    if (attemptCount >= MAX_ATTEMPTS) {
      // Audit the rate-limited attempt
      const auditCtx = buildAuditContext({
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      await writeAudit(db, {
        action: 'customer.reauth.rate_limited',
        actor: customerActor({ id: customerId, label: customerLabel(ctx.customer) }),
        target: noTarget(),
        context: auditCtx,
        meta: { attemptCount, windowMinutes: WINDOW_MINUTES },
        ts: now,
      });
      return ctx.errorJson('rate_limited', 'Too many verification attempts. Please try again later.', 429);
    }

    // --- 3. Fetch password hash from DB (not available in CustomerContext) ---
    const hashResult = await db.execute<{ password_hash: string | null }>(
      sql`SELECT password_hash FROM customers WHERE id = ${customerId} LIMIT 1`,
    );
    const hashRow = hashResult.rows[0] as { password_hash: string | null } | undefined;
    if (!hashRow) {
      return ctx.errorJson('internal_error', 'Account not found.', 500);
    }
    // Wallet-only users have no password, reauth is not applicable
    if (hashRow.password_hash === null) {
      return ctx.errorJson('no_password', 'This account does not have a password set.', 400);
    }

    // --- 4. Verify password ---
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    const passwordValid = await verifyPassword(body.password, hashRow.password_hash);
    if (!passwordValid) {
      await writeAudit(db, {
        action: 'customer.reauth.failed',
        actor: customerActor({ id: customerId, label: customerLabel(ctx.customer) }),
        target: noTarget(),
        context: auditCtx,
        meta: { sessionId: ctx.session.sessionId },
        ts: now,
      });
      return ctx.errorJson('unauthenticated', 'Incorrect password.', 401);
    }

    // --- 5. Success ---
    await writeAudit(db, {
      action: 'customer.reauth.success',
      actor: customerActor({ id: customerId, label: customerLabel(ctx.customer) }),
      target: noTarget(),
      context: auditCtx,
      meta: { sessionId: ctx.session.sessionId },
      ts: now,
    });

    return ctx.json({ verified: true });
  },
});
