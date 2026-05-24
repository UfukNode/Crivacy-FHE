/**
 * POST /api/customer/auth/google/initiate
 *
 * Start Google OAuth flow. Returns the Google consent URL and sets
 * a httpOnly nonce cookie for CSRF protection.
 *
 * If Google OAuth is not configured (GOOGLE_CLIENT_ID empty), returns 404.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { buildRequestContext } from '@/server/context';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import { buildGoogleAuthUrl, generateOAuthState } from '@/lib/customer/google-oauth';
import type { OAuthMode } from '@/lib/customer/google-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { OAUTH_NONCE_COOKIE, CUSTOMER_ACCESS_COOKIE } from '@/lib/auth/cookie-names';
import { sanitizeSameOriginPath } from '@/lib/security/safe-redirect';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  // Per-IP rate limit (F-A2-001): cap a malicious actor that would
  // otherwise spam the consent-screen redirect to noise the rate-
  // limit-events table or burn cookie/state-JWT entropy probing for
  // signing-key issues. Mirrors `customer_login` cap.
  const limited = await maybeRateLimitResponse(db, 'customer_oauth_initiate', ctx.ip, ctx.now);
  if (limited) return limited;

  const customerConfig = getCustomerAuthConfig();

  // Guard: Google OAuth not configured
  if (!customerConfig.googleClientId || !customerConfig.googleClientSecret) {
    return ctx.errorJson('not_found', 'Google login is not available.', 404);
  }

  const authConfig = getAuthConfig();

  // Parse optional mode from query string (?mode=link)
  const modeParam = request.nextUrl.searchParams.get('mode');
  const mode: OAuthMode = modeParam === 'link' ? 'link' : 'login';

  // For link mode, read the customer session NOW (same-origin POST → cookie available).
  // We embed customerId in the state JWT so the callback doesn't depend on
  // SameSite=Strict cookies (which are NOT sent on cross-origin redirects from Google).
  let customerId: string | undefined;
  if (mode === 'link') {
    const accessToken = request.cookies.get(CUSTOMER_ACCESS_COOKIE)?.value;
    if (!accessToken) {
      return ctx.errorJson('unauthorized', 'You must be logged in to link Google.', 401);
    }
    try {
      const verified = await verifyAccessToken(accessToken, authConfig);
      if (verified.kind !== 'customer') {
        return ctx.errorJson('unauthorized', 'Invalid session.', 401);
      }
      customerId = verified.sub;
    } catch {
      return ctx.errorJson('unauthorized', 'Session expired. Please refresh and try again.', 401);
    }
  }

  // Optional `continue` landing path. Only honoured for login mode
  // (link mode always returns to /settings/security). Must be a
  // same-origin absolute path, reject protocol-relative `//evil`
  // and absolute URLs pointing at any other host.
  let continueTo: string | undefined;
  if (mode === 'login') {
    const body = (await request
      .json()
      .catch(() => ({}))) as { readonly from?: unknown };
    if (typeof body.from === 'string') {
      // Central helper, backslash/control-char/unicode edge cases
      // (AUD-X-REDIRECT-001).
      const safe = sanitizeSameOriginPath(body.from);
      if (safe !== '/') continueTo = safe;
    }
  }

  // Generate state + nonce + PKCE pair (mode + customerId +
  // continueTo + verifier all embedded in the signed JWT; only the
  // S256 challenge travels in the URL).
  const { stateJwt, nonce, codeChallenge } = await generateOAuthState(
    authConfig.jwtSecret,
    mode,
    customerId,
    continueTo,
  );

  // Build auth URL, challenge is the public half of the PKCE pair.
  const authUrl = buildGoogleAuthUrl(customerConfig, stateJwt, codeChallenge);

  const isProduction = process.env.NODE_ENV === 'production';

  const response = NextResponse.json(
    { url: authUrl },
    {
      status: 200,
      headers: {
        'x-request-id': ctx.requestId,
        'cache-control': 'no-store',
      },
    },
  );

  // Set nonce cookie (10 min, httpOnly, strict)
  response.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax', // Must be lax for cross-origin redirect
    path: '/',
    maxAge: 600, // 10 minutes
  });

  return response;
}
