/**
 * POST /api/customer/kyc/handoff/[token]
 *
 * PUBLIC route, no customer authentication required. The handoff token
 * itself serves as the authentication mechanism. The mobile device presents
 * the token to consume it and receive the Didit redirect URL.
 *
 * **Method matters.** This used to be `GET` and the page component fetched
 * it on mount. State-changing endpoints under GET are vulnerable to
 * prefetchers and link-preview bots that issue background GETs against any
 * URL surfaced in the app, they would burn the one-shot token before the
 * mobile user reached the page. The fix is the HTTP rule: state-changing
 * endpoints MUST be POST. Page now fires a same-origin POST on mount; the
 * Origin guard rejects any cross-site form post (the only other vector
 * that could automate a POST without page execution).
 *
 * Security: token is hashed (SHA-256) before lookup; only the hash is stored
 * in the database. Tokens are one-time use and expire after 10 minutes.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { handleConsumeHandoff } from '@/server/handlers/customer-kyc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  // Same-origin Origin guard. Cancels are public-by-design (no auth) so a
  // cross-site form post could otherwise burn an arbitrary in-flight token
  // if an attacker tricked a user into submitting one. Compare against
  // the raw `Host` header (NextURL strips the port in some runtime
  // configurations and produced false same-origin mismatches).
  const origin = request.headers.get('origin');
  const hostHeader = request.headers.get('host');
  if (origin !== null && hostHeader !== null) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return NextResponse.json(
        { error: { code: 'invalid_origin', message: 'Invalid origin.' } },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      );
    }
    if (parsed.host !== hostHeader) {
      return NextResponse.json(
        { error: { code: 'cross_origin', message: 'Cross-origin handoff rejected.' } },
        { status: 403, headers: { 'cache-control': 'no-store' } },
      );
    }
  }

  const { token } = await params;

  // Validate token format: must be a 64-char hex string (32 bytes)
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    return NextResponse.json(
      { error: { code: 'invalid_token', message: 'Invalid handoff token format.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const { db } = getDatabaseClient();
  const ctx = buildRequestContext(request, db);

  return handleConsumeHandoff(ctx, token);
}
