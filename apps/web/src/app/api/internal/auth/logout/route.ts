/**
 * POST /api/internal/auth/logout, revoke dashboard session + clear cookies
 */

import { NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { DASHBOARD_ACCESS_COOKIE, DASHBOARD_REFRESH_COOKIE } from '@/lib/auth/cookie-names';
import { handleLogout } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJti,
  findSessionByJtiForMiddleware,
  revokeDashboardSession,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Intentionally NOT permission-gated, logout should always succeed
// for any authenticated firm user regardless of their permission set.
// A user locked out by a partial permission backfill must still be
// able to sign out cleanly.
export const POST = dashboardRoute({
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    await handleLogout(
      {
        db: ctx.db,
        findSessionByJti,
        revokeSession: revokeDashboardSession,
      },
      ctx.session.jti,
    );

    // Clear auth cookies
    const isProduction = process.env.NODE_ENV === 'production';
    const response = NextResponse.json(
      { message: 'Logged out.' },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    response.cookies.set(DASHBOARD_ACCESS_COOKIE, '', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    });

    response.cookies.set(DASHBOARD_REFRESH_COOKIE, '', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/internal/auth/refresh',
      maxAge: 0,
    });

    return response;
  },
});
