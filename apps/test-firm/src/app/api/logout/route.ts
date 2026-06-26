/**
 * POST /api/logout — full TestFirm logout.
 *
 * Destroys:
 *   1. TestFirm session (removes token from the in-memory session
 *      map; clears the `tf_session` cookie).
 *   2. Crivacy OAuth cookies (access_token, scope, state) — we
 *      don't revoke the token upstream (Crivacy has no revocation
 *      endpoint yet), but the TestFirm browser state is wiped.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { TEST_FIRM_COOKIES } from '../../config';
import { TF_SESSION_COOKIE, clearSessionCookie } from '../../session';
import { destroySession } from '../../user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const sessionToken = request.cookies.get(TF_SESSION_COOKIE)?.value ?? null;
  destroySession(sessionToken);

  const homeUrl = new URL('/', request.url);
  const res = NextResponse.redirect(homeUrl, { status: 303 });

  clearSessionCookie(res);
  res.cookies.delete(TEST_FIRM_COOKIES.accessToken);
  res.cookies.delete(TEST_FIRM_COOKIES.scope);
  res.cookies.delete(TEST_FIRM_COOKIES.state);
  return res;
}
