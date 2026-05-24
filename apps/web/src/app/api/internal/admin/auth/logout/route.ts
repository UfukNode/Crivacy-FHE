/**
 * POST /api/internal/admin/auth/logout, revoke admin session + clear cookies
 */

import { NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { ADMIN_ACCESS_COOKIE, ADMIN_REFRESH_COOKIE } from '@/lib/auth/cookie-names';
import { handleAdminLogout } from '@/server/handlers';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
  findSessionByJti,
  revokeAdminSession,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Intentionally NOT permission-gated, logout must always succeed
// regardless of effective permission state.
export const POST = adminRoute({
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    await handleAdminLogout(
      {
        db: ctx.db,
        revokeSession: revokeAdminSession,
        findSessionByJti,
        clock: () => ctx.now,
      },
      ctx.session.jti,
    );

    // Clear auth cookies
    const isProduction = process.env.NODE_ENV === 'production';
    const response = NextResponse.json(
      { message: 'Logged out.' },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    response.cookies.set(ADMIN_ACCESS_COOKIE, '', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    });

    response.cookies.set(ADMIN_REFRESH_COOKIE, '', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/internal/admin/auth/refresh',
      maxAge: 0,
    });

    return response;
  },
});
