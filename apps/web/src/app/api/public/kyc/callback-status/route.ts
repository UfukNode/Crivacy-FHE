/**
 * GET /api/public/kyc/callback-status?session=<diditSessionId>
 *
 * PUBLIC route, no Crivacy auth required. The Didit `verificationSessionId`
 * (an unguessable UUID) acts as the bearer token. Used exclusively by
 * the phone-handoff variant of the `/kyc/callback` page: the mobile
 * device opened by QR scan has no customer cookie, so the auth-gated
 * `/api/customer/kyc/callback-status` correctly 401s for that device
 *, but the page would then show the neutral "submitted" copy even
 * for declines. This sibling lets the page surface the actual variant
 * to the phone user without leaking PII.
 *
 * Response is a strict subset: only `variant` + `isTerminal`. Callers
 * needing the richer payload (phase, continueUrl, sessionStatus) must
 * authenticate via the customer cookie.
 *
 * Same-origin guard: Origin header must match Host. Prevents an
 * arbitrary site from probing the variant via an XHR to a leaked
 * session id (the leaked id alone is bearer-grade, but defence-in-
 * depth on top is cheap).
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { getDatabaseClient } from '@/lib/db/client';
import { handlePublicCallbackStatus } from '@/server/handlers/customer-kyc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Same-origin Origin guard. Only enforced when an Origin header is
  // present, direct browser navigations / curl have none and that's
  // fine. The shape mirrors the handoff endpoint's guard.
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
        { error: { code: 'cross_origin', message: 'Cross-origin lookup rejected.' } },
        { status: 403, headers: { 'cache-control': 'no-store' } },
      );
    }
  }

  const url = new URL(request.url);
  const diditSessionId = url.searchParams.get('session') ?? '';

  const { db } = getDatabaseClient();
  return handlePublicCallbackStatus(db, diditSessionId);
}
