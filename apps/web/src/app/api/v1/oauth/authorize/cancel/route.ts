/**
 * POST /api/v1/oauth/authorize/cancel
 *
 * Unauthenticated escape hatch from any sub-flow that can strand a
 * user between `/oauth/authorize` and the consent decision (login
 * bounce, signup bounce, KYC detour). Given a still-valid
 * `authorization_request` row, we mark it completed and bounce the
 * user back to the firm with the standard OAuth
 * `error=access_denied` signal so the firm can show a retry
 * affordance.
 *
 * **Method matters.** This used to be `GET` and the login/register
 * pages reached it through a Next.js `<Link>`. Next.js prefetches
 * `<Link>` hrefs on viewport entry, which fired the cancel handler
 * before the user clicked anything, silently killing the
 * authorize_request mid-login-bounce so the post-login consent
 * page rendered as "Already completed". The fix is the HTTP rule:
 * state-changing endpoints MUST be POST. The cancel UI is now a
 * `<form method="POST">` so prefetchers can no longer trigger it.
 *
 * Why it's unauthenticated: the user hasn't logged in yet in the
 * scenarios that need this, and requiring auth here would either
 * force the cancellation off a page they can't reach (login) or
 * defeat the whole point. The only thing the caller needs to know
 * is the opaque `request_id` they already hold, the same caller
 * who walked through `/authorize` in the first place. Impact of
 * cancelling a foreign request is capped at "firm sees
 * access_denied and user retries", no token, no secret, no
 * mutation beyond a single row flip.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getDatabaseClient } from '@/lib/db/client';
import {
  findAuthorizationRequest,
  markAuthorizationRequestCompleted,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  // Same-origin guard. Cancel is unauthenticated by design (the
  // user is mid-bounce, no session yet) so cross-site form posts
  // would otherwise cancel arbitrary in-flight requests if an
  // attacker tricked a user into submitting one. Reject any POST
  // whose Origin does not match the request host. Compare to the
  // raw `Host` header rather than `request.nextUrl.host` because
  // Next.js' NextURL strips the port in some runtime configurations,
  // producing false `host.docker.internal:3001 ≠ host.docker.internal`
  // mismatches even on legitimate same-origin form posts.
  const origin = request.headers.get('origin');
  const hostHeader = request.headers.get('host');
  if (origin !== null && hostHeader !== null) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return new NextResponse('Invalid origin.', { status: 400 });
    }
    if (parsed.host !== hostHeader) {
      return new NextResponse('Cross-origin cancel rejected.', { status: 403 });
    }
  }

  // Pull request id from form body (preferred) or, as a fallback
  // for clients that still send it as a query string, from the URL.
  let requestId: string | null = null;
  try {
    const form = await request.formData();
    const value = form.get('request');
    if (typeof value === 'string') requestId = value;
  } catch {
    // Body was not multipart/urlencoded, fall through to query.
  }
  if (requestId === null || requestId.length === 0) {
    requestId = request.nextUrl.searchParams.get('request');
  }
  if (requestId === null || requestId.length === 0) {
    return new NextResponse('Missing request parameter.', { status: 400 });
  }

  const db = getDatabaseClient().db;
  const authRequest = await findAuthorizationRequest(db, requestId);
  if (authRequest === null) {
    return new NextResponse('Authorization request not found.', { status: 404 });
  }

  const now = new Date();
  if (authRequest.completedAt !== null) {
    // Idempotent, if the cancel URL is retried after a successful
    // first invocation, just bounce the user to the firm with the
    // same access_denied signal rather than 409-ing.
    return redirectWithError(authRequest.redirectUri, authRequest.state);
  }
  if (authRequest.expiresAt.getTime() <= now.getTime()) {
    // Expired requests can no longer be "cancelled" meaningfully; the
    // firm's flow already timed out. Send the user to a friendly
    // explanation instead of to a stale redirect_uri.
    return new NextResponse(
      'This authorization request has expired. Please return to the partner site and try again.',
      { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }

  await markAuthorizationRequestCompleted(db, requestId, now);
  return redirectWithError(authRequest.redirectUri, authRequest.state);
}

function redirectWithError(redirectUri: string, state: string | null): NextResponse {
  const target = new URL(redirectUri);
  target.searchParams.set('error', 'access_denied');
  target.searchParams.set('error_description', 'User cancelled before completing authorization.');
  if (state !== null) target.searchParams.set('state', state);
  // 303 See Other, the spec-correct status for "POST handled,
  // please GET this next URL." Avoids ambiguity around browsers
  // re-submitting the form against the firm's redirect_uri.
  return NextResponse.redirect(target.toString(), { status: 303 });
}
