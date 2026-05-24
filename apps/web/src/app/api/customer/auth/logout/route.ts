/**
 * POST /api/customer/auth/logout
 *
 * Revoke the current customer session and clear auth cookies.
 * Requires a valid customer session (uses customerRoute middleware).
 *
 * If the access token is expired, the middleware returns 401 and
 * the client is expected to clear cookies on its own.
 */

import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';

import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { CUSTOMER_ACCESS_COOKIE, CUSTOMER_REFRESH_COOKIE } from '@/lib/auth/cookie-names';

const ACCESS_TOKEN_COOKIE = CUSTOMER_ACCESS_COOKIE;
const REFRESH_TOKEN_COOKIE = CUSTOMER_REFRESH_COOKIE;
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
  allowUnverified: true,
  handler: async (ctx) => {
    const db = ctx.db;
    const now = ctx.now;

    // --- 1. Revoke session ---
    await db.execute(
      sql`UPDATE customer_sessions
       SET revoked_at = ${now.toISOString()}, revoked_reason = 'logout'
       WHERE id = ${ctx.session.sessionId} AND revoked_at IS NULL`,
    );

    // --- 2. Audit ---
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
    await writeAudit(db, {
      action: 'customer.logout',
      actor: systemActor('customer-auth'),
      target: noTarget(),
      context: auditCtx,
      meta: {
        customerId: ctx.customer.id,
        sessionId: ctx.session.sessionId,
      },
      ts: now,
    });

    // --- 3. Clear cookies ---
    const isProduction = process.env.NODE_ENV === 'production';

    const response = NextResponse.json(
      { message: 'Logged out successfully.' },
      {
        status: 200,
        headers: {
          'x-request-id': ctx.requestId,
          'cache-control': 'no-store',
        },
      },
    );

    response.cookies.set(ACCESS_TOKEN_COOKIE, '', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    });

    response.cookies.set(REFRESH_TOKEN_COOKIE, '', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/customer/auth/refresh',
      maxAge: 0,
    });

    return response;
  },
});
