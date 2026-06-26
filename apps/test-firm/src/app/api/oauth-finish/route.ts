/**
 * POST /api/oauth-finish — token exchange + identity persistence.
 *
 * Called by the callback page AFTER the browser has validated state
 * and retrieved the PKCE verifier from sessionStorage. This route:
 *
 *   1. Takes `{ code, codeVerifier }` from the client.
 *   2. POSTs to Crivacy `/oauth/token` with `client_id` + `client_secret`
 *      + the verifier (defence-in-depth; the server-side PKCE check
 *      still runs because the snippet sent a challenge at /authorize).
 *   3. Fetches `/userinfo` with the returned Bearer token.
 *   4. Persists the claims against the TestFirm user in the data store.
 *   5. Sets the TestFirm-scoped `tf_access_token` + `tf_scope` cookies.
 *
 * Keeps `client_secret` out of the browser entirely — the secret
 * never crosses the network boundary between TestFirm backend and
 * TestFirm client.
 */

import { z } from 'zod';
import { NextResponse, type NextRequest } from 'next/server';

import { TEST_FIRM_COOKIES, loadTestFirmConfig } from '../../config';
import { upsertOauthIdentity, type UserinfoClaims } from '../../data-store';
import { TF_SESSION_COOKIE } from '../../session';
import { findUserBySession } from '../../user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  code: z.string().min(1).max(1024),
  codeVerifier: z.string().min(43).max(128),
});

interface TokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly scope: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const cfg = loadTestFirmConfig();

  // Guard: the caller must be a logged-in TestFirm user. Without
  // that, we have nobody to attribute the Crivacy identity to.
  const tfToken = request.cookies.get(TF_SESSION_COOKIE)?.value ?? null;
  const tfUser = findUserBySession(tfToken);
  if (tfUser === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let parsed;
  try {
    parsed = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'bad_payload' }, { status: 400 });
  }

  // --- Token exchange ------------------------------------------------
  const tokenBody = new URLSearchParams();
  tokenBody.set('grant_type', 'authorization_code');
  tokenBody.set('code', parsed.code);
  tokenBody.set('redirect_uri', cfg.redirectUri);
  tokenBody.set('client_id', cfg.oauthClientId);
  tokenBody.set('client_secret', cfg.oauthClientSecret);
  tokenBody.set('code_verifier', parsed.codeVerifier);

  let tokenRes: Response;
  try {
    tokenRes = await fetch(`${cfg.apiBaseUrl}/api/v1/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: tokenBody.toString(),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'token_network_error' }, { status: 502 });
  }

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    // eslint-disable-next-line no-console
    console.warn('[test-firm] token exchange failed:', tokenRes.status, text.slice(0, 200));
    return NextResponse.json({ error: 'token_exchange_failed' }, { status: 502 });
  }

  let tokenJson: TokenResponse;
  try {
    tokenJson = (await tokenRes.json()) as TokenResponse;
  } catch {
    return NextResponse.json({ error: 'token_parse_failed' }, { status: 502 });
  }
  if (
    typeof tokenJson.access_token !== 'string' ||
    typeof tokenJson.expires_in !== 'number' ||
    typeof tokenJson.scope !== 'string'
  ) {
    return NextResponse.json({ error: 'token_shape_invalid' }, { status: 502 });
  }

  // --- Userinfo fetch + identity persist ----------------------------
  try {
    const userinfoRes = await fetch(`${cfg.apiBaseUrl}/api/v1/oauth/userinfo`, {
      headers: {
        authorization: `Bearer ${tokenJson.access_token}`,
        accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (userinfoRes.ok) {
      const claims = (await userinfoRes.json()) as UserinfoClaims;
      if (typeof claims.sub === 'string' && claims.sub.length > 0) {
        upsertOauthIdentity({
          firmUserId: tfUser.id,
          crivacySub: claims.sub,
          scope: tokenJson.scope,
          claims,
        });
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[test-firm] /userinfo call failed:', (err as Error).message);
  }

  // --- Response with cookies ----------------------------------------
  const res = NextResponse.json({ ok: true }, { status: 200 });
  const isProduction = process.env['NODE_ENV'] === 'production';
  const cookieTtl = Math.max(60, tokenJson.expires_in);

  res.cookies.set(TEST_FIRM_COOKIES.accessToken, tokenJson.access_token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: cookieTtl,
  });
  res.cookies.set(TEST_FIRM_COOKIES.scope, tokenJson.scope, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: cookieTtl,
  });

  return res;
}
