/**
 * POST /api/unlink-crivacy — remove a firm user's Crivacy
 * identity link.
 *
 * Distinct from `/api/logout` (which clears the firm-side
 * session cookie). This endpoint detaches the OAuth identity:
 *   * the stored claims (level, contract id, proof hash) are
 *     deleted from the firm data-store
 *   * the firm-side access_token + scope cookies are cleared
 *   * the firm user remains signed in to their firm account
 *
 * Use cases:
 *   * User wants to re-verify with a different Crivacy account
 *   * User exercises a privacy "disconnect" affordance
 *   * Firm support clears a stale link before the user re-runs OAuth
 *
 * The Crivacy session and the on-chain credential itself are NOT
 * affected — Crivacy stays signed in on its own surface, and the
 * credential contract remains on Sepolia until Crivacy itself
 * archives it. Unlinking is purely a firm-side data-store action.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { TEST_FIRM_COOKIES } from '../../config';
import { deleteOauthIdentitiesForUser } from '../../data-store';
import { TF_SESSION_COOKIE } from '../../session';
import { findUserBySession } from '../../user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const tfToken = request.cookies.get(TF_SESSION_COOKIE)?.value ?? null;
  const tfUser = findUserBySession(tfToken);
  if (tfUser === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const removed = deleteOauthIdentitiesForUser(tfUser.id);

  const res = NextResponse.json({ removed }, { status: 200 });
  // Clear the firm-side OAuth cookies. The token itself stays usable
  // against Crivacy until natural expiry; the firm just stops
  // presenting it. (A future iteration could call
  // POST /api/v1/oauth/revoke to invalidate server-side too.)
  for (const cookieName of [TEST_FIRM_COOKIES.accessToken, TEST_FIRM_COOKIES.scope]) {
    res.cookies.set(cookieName, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env['NODE_ENV'] === 'production',
      path: '/',
      maxAge: 0,
    });
  }
  return res;
}
