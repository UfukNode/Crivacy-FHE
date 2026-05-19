/**
 * OAuth /authorize handler — the entry point firms redirect users to.
 *
 * The handler is intentionally NOT wrapped in the api-route middleware
 * chain: this endpoint answers to end-users coming in on their own
 * cookie (or none), not to api-key-bearing server-to-server traffic.
 * It never issues tokens directly — it produces a signed resume
 * ticket (`request_id`) and hands the browser to either the login,
 * signup, KYC, or consent page to continue.
 *
 * Flow:
 *
 *   1. Validate `client_id`, look up the client record.
 *      Bad client → static error page (no redirect — can't trust it).
 *   2. Validate `redirect_uri` against the client's whitelist.
 *      Mismatch → static error page.
 *   3. Validate `response_type`, `scope`, PKCE.
 *      Failures → redirect to `redirect_uri` with `error=…`.
 *   4. Mint a `request_id`, persist the authorize state, drop a
 *      short-lived cookie so subsequent pages can resume.
 *   5. Redirect the user to `/oauth/consent/<request_id>` — the
 *      consent page itself decides whether to force login/signup/
 *      KYC first.
 *
 * @module
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { enforceAuthRateLimit } from '@/lib/auth-rate-limit';
import { CUSTOMER_ACCESS_COOKIE } from '@/lib/auth/cookie-names';
import { getAuthConfig } from '@/lib/auth/config';
import { verifyAccessToken } from '@/lib/auth/jwt';
import {
  AUTHORIZATION_REQUEST_TTL_SECONDS,
  OauthError,
  assertScopeAllowed,
  assertValidCodeChallenge,
  generateAuthorizationRequestId,
  parseScope,
  validateRedirectUri,
} from '@/lib/oauth';
import {
  findOauthClientByClientId,
  insertAuthorizationRequest,
} from '@/server/repositories';
import type { CrivacyDatabase } from '@/lib/db/client';

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

interface AuthorizeQuery {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly responseType: string;
  readonly scope: string;
  readonly state: string | null;
  readonly codeChallenge: string | null;
  readonly codeChallengeMethod: string | null;
  readonly nonce: string | null;
  readonly uiLocales: string | null;
}

function readQuery(url: URL): AuthorizeQuery {
  const get = (name: string): string | null => {
    const v = url.searchParams.get(name);
    return v !== null && v.length > 0 ? v : null;
  };
  return {
    clientId: get('client_id') ?? '',
    redirectUri: get('redirect_uri') ?? '',
    responseType: get('response_type') ?? '',
    scope: get('scope') ?? '',
    state: get('state'),
    codeChallenge: get('code_challenge'),
    codeChallengeMethod: get('code_challenge_method'),
    nonce: get('nonce'),
    uiLocales: get('ui_locales'),
  };
}

// ---------------------------------------------------------------------------
// Error redirect helpers
// ---------------------------------------------------------------------------

/**
 * Build a safe error redirect back to the firm. Uses URLSearchParams
 * so the `state` echo doesn't get double-encoded and the caller
 * can't inject CRLF via a crafted state value.
 */
function redirectToClientWithError(
  redirectUri: string,
  error: string,
  errorDescription: string,
  state: string | null,
): NextResponse {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', errorDescription);
  if (state !== null) url.searchParams.set('state', state);
  return NextResponse.redirect(url.toString(), { status: 302 });
}

/**
 * Render a static error page when we cannot safely redirect (bad
 * client_id or redirect_uri mismatch — in both cases the redirect
 * target is untrusted). The page is plain HTML; no framework
 * dependency so this handler can stay independent of the app tree.
 */
function renderUntrustedError(status: number, title: string, detail: string): NextResponse {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:14px/1.6 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 24px;color:#e5e5e5;background:#0a0a0a}h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px;color:#a1a1a1}code{background:#1a1a1a;padding:2px 6px;border-radius:4px;color:#60d394}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p>If you reached this page from a partner site, please contact their support team.</p></body></html>`;
  return new NextResponse(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Static HTML 429 page for the rate-limit path. We can't redirect
 * (the `redirect_uri` hasn't been validated yet — and even after,
 * we don't want to carry a rate-limit signal into the firm's flow)
 * and we can't ship JSON (the caller is a browser that ended up
 * here via a partner-site redirect, not a fetch). The page mirrors
 * `renderUntrustedError` so the visual break between "bad request"
 * and "too many requests" stays consistent, but the response
 * carries the mandatory `Retry-After` header so well-behaved
 * automation backs off on its own.
 */
function renderRateLimited(retryAfterSeconds: number): NextResponse {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Too many requests</title>
<style>body{font:14px/1.6 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 24px;color:#e5e5e5;background:#0a0a0a}h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px;color:#a1a1a1}code{background:#1a1a1a;padding:2px 6px;border-radius:4px;color:#60d394}</style>
</head><body><h1>Too many requests</h1><p>This sign-in flow is temporarily rate-limited. Please wait about ${retryAfterSeconds} seconds and try again.</p><p>If you reached this page from a partner site, return there and retry once the cooldown passes.</p></body></html>`;
  return new NextResponse(body, {
    status: 429,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': String(retryAfterSeconds),
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface OauthAuthorizeDeps {
  readonly db: CrivacyDatabase;
  readonly now: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export async function handleOauthAuthorize(
  deps: OauthAuthorizeDeps,
  request: NextRequest,
): Promise<NextResponse> {
  // --- 0. Per-IP rate limit ---------------------------------------------
  //
  // Runs BEFORE any DB lookup so a brute-force scan against
  // `client_id` (or any crafted-query DoS) never pays the client
  // + redirect-uri validation round-trip. Fails open when the rate
  // limiter itself errors so a transient DB hiccup on the limiter
  // path never locks the whole authorize surface. The 30/min
  // ceiling leaves ample headroom for legitimate flows (one
  // authorize per minute per IP is already an aggressive human
  // pattern) but kills scripted replays.
  const rateLimit = await enforceAuthRateLimit(
    deps.db,
    'oauth_authorize',
    deps.ip,
    deps.now,
  );
  if (!rateLimit.allowed) {
    return renderRateLimited(rateLimit.retryAfterSeconds);
  }

  // Next dev exposes `request.url` with the bind host (loopback) even
  // when the browser is on a LAN IP — that yields cross-origin
  // redirects to /login and /oauth/consent that trip CSP form-action
  // checks and wipe sessionStorage by origin. Rebuild the URL on the
  // actual `Host` header so every downstream redirect stays on the
  // origin the browser is already on.
  const hostHeader = request.headers.get('host');
  const baseUrl = (() => {
    if (hostHeader !== null && hostHeader.length > 0) {
      const proto = request.headers.get('x-forwarded-proto') ?? 'http';
      const rawUrl = new URL(request.url);
      return new URL(`${rawUrl.pathname}${rawUrl.search}`, `${proto}://${hostHeader}`);
    }
    return new URL(request.url);
  })();
  const url = baseUrl;
  const query = readQuery(url);

  // --- 1. Client lookup --------------------------------------------------
  if (query.clientId.length === 0) {
    return renderUntrustedError(
      400,
      'Missing client_id',
      'The authorize URL is missing its client_id parameter.',
    );
  }
  const client = await findOauthClientByClientId(deps.db, query.clientId);
  if (client === null) {
    return renderUntrustedError(
      400,
      'Unknown client',
      'This client_id is not registered or has been revoked.',
    );
  }

  // --- 2. Redirect URI check --------------------------------------------
  if (query.redirectUri.length === 0) {
    return renderUntrustedError(
      400,
      'Missing redirect_uri',
      'The authorize URL is missing its redirect_uri parameter.',
    );
  }
  const redirectCheck = validateRedirectUri(query.redirectUri, client.redirectUris);
  if (!redirectCheck.ok) {
    return renderUntrustedError(
      400,
      'Invalid redirect_uri',
      redirectCheck.reason,
    );
  }
  // From this point on, the redirect_uri is trusted. Errors may flow
  // back to it per RFC 6749 §4.1.2.1.
  const trustedRedirect = query.redirectUri;

  // --- 3. Response type --------------------------------------------------
  if (query.responseType !== 'code') {
    return redirectToClientWithError(
      trustedRedirect,
      'unsupported_response_type',
      'Only response_type=code is supported.',
      query.state,
    );
  }

  // --- 4. Scope validation ----------------------------------------------
  let parsedScopes;
  try {
    parsedScopes = parseScope(query.scope);
  } catch (err) {
    if (err instanceof OauthError) {
      return redirectToClientWithError(trustedRedirect, err.code, err.message, query.state);
    }
    throw err;
  }
  try {
    assertScopeAllowed(parsedScopes, client.allowedScopes as ReturnType<typeof parseScope>);
  } catch (err) {
    if (err instanceof OauthError) {
      return redirectToClientWithError(trustedRedirect, err.code, err.message, query.state);
    }
    throw err;
  }

  // --- 5. PKCE validation -----------------------------------------------
  // Public clients MUST use PKCE (RFC 9700 §2.1.1). Confidential
  // clients MAY use it (defence-in-depth). Either way we validate
  // the shape up front so the consent screen can carry a guaranteed-
  // valid challenge forward to /token.
  const needsPkce = client.isPublicClient;
  if (needsPkce && query.codeChallenge === null) {
    return redirectToClientWithError(
      trustedRedirect,
      'invalid_request',
      'PKCE code_challenge is required for public clients.',
      query.state,
    );
  }
  if (query.codeChallenge !== null) {
    try {
      assertValidCodeChallenge(query.codeChallenge, query.codeChallengeMethod ?? 'S256');
    } catch (err) {
      if (err instanceof OauthError) {
        return redirectToClientWithError(trustedRedirect, err.code, err.message, query.state);
      }
      throw err;
    }
  }

  // --- 6. Decode the customer session cookie (best-effort) --------------
  //
  // When the caller already holds a valid session we bind the
  // request to their customer id right now. Downstream handlers
  // (consent bootstrap / submit / start-from-consent) then refuse
  // any attempt to drive this request with a different session —
  // no more "user A starts authorize, user B finishes it on the
  // same shared browser" swap.
  //
  // Failure is intentionally silent: a missing, malformed, or
  // expired cookie just means we persist `userId: null` and the
  // consent bootstrap will either redirect to /login or attach the
  // customer on first sight (TOFU). Throwing here would block
  // legitimate unauthenticated authorize flows that resolve through
  // login → consent.
  const accessCookie = request.cookies.get(CUSTOMER_ACCESS_COOKIE)?.value;
  let boundUserId: string | null = null;
  if (accessCookie !== undefined && accessCookie.length > 0) {
    try {
      const verified = await verifyAccessToken(accessCookie, getAuthConfig(), deps.now);
      if (verified.kind === 'customer') {
        boundUserId = verified.sub;
      }
    } catch {
      // ignore — fall through as anonymous
    }
  }

  // --- 7. Persist authorization request ---------------------------------
  const requestId = generateAuthorizationRequestId();
  const expiresAt = new Date(deps.now.getTime() + AUTHORIZATION_REQUEST_TTL_SECONDS * 1000);
  await insertAuthorizationRequest(deps.db, {
    requestId,
    clientId: client.id,
    userId: boundUserId,
    redirectUri: trustedRedirect,
    scope: parsedScopes.join(' '),
    state: query.state,
    codeChallenge: query.codeChallenge,
    codeChallengeMethod: query.codeChallengeMethod ?? (query.codeChallenge !== null ? 'S256' : null),
    uiLocales: query.uiLocales,
    nonce: query.nonce,
    ip: deps.ip,
    userAgent: deps.userAgent,
    expiresAt,
  });

  // --- 8. Decide where to land the browser -------------------------------
  // Sector-standard UX (Stripe, Google, GitHub): if the end-user is
  // not signed in to the IdP, jump straight to the login page and
  // skip any intermediate "checking..." card flash. The consent page
  // still defends itself with its own 401 → /login bounce (runs
  // client-side), but doing the bounce HERE eliminates the
  // half-a-second of empty-skeleton that unauthenticated users would
  // otherwise see.
  //
  // Cookie PRESENCE only — full session verification still happens
  // in the bootstrap endpoint. Presence is enough to decide "skip
  // login" vs "send to login" at the redirect fork; a stale cookie
  // hitting the bootstrap still trips the 401 → /login guard.
  const consentPath = `/oauth/consent?request=${encodeURIComponent(requestId)}`;
  const hasCustomerSession = request.cookies.get(CUSTOMER_ACCESS_COOKIE) !== undefined;
  const nextPath = hasCustomerSession
    ? consentPath
    : `/login?from=${encodeURIComponent(consentPath)}`;

  const next = new URL(nextPath, url);
  return NextResponse.redirect(next.toString(), { status: 302 });
}
