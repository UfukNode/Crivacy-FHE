/**
 * POST /api/v1/oauth/token, OAuth 2.0 token endpoint.
 *
 * Thin wrapper around `handleOauthToken`. Content-Type handling,
 * error response shaping, and all flow logic live in the handler.
 */

import type { NextRequest } from 'next/server';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { extractClientIp } from '@/server/context';
import { handleOauthToken } from '@/server/handlers/oauth-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const db = getDatabaseClient().db;
  const now = new Date();
  // Routed through the canonical IP extractor so `AUTH_TRUSTED_PROXY_HOPS`
  // + `CF-Connecting-IP` precedence is respected. Used as the IP-binding
  // subject for the authorization-code grant and as the rate-limit
  // fallback when no `client_id` is present on the body.
  const ip = extractClientIp(request);

  // Per-client_id rate-limit: one firm brute-forcing a secret gets
  // capped without IP-rotating around the cap, and a busy firm
  // isn't starved by a single shared IP bucket. We clone the
  // request so the handler still sees the original body; extracting
  // the field server-side lets us block before hitting the handler.
  // Falls back to IP when `client_id` is absent so unshaped token
  // requests still get a ceiling.
  let rateLimitKey: string | null = ip;
  try {
    const cloned = request.clone();
    const bodyText = await cloned.text();
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const clientId = new URLSearchParams(bodyText).get('client_id');
      if (clientId !== null && clientId.length > 0) rateLimitKey = clientId;
    }
  } catch {
    // Body unreadable at this stage (shouldn't happen for a fresh
    // request), fall back to IP keying.
  }
  const limited = await maybeRateLimitResponse(db, 'oauth_token', rateLimitKey, now);
  if (limited !== null) return limited;

  const issuerUrl = getAuthConfig().jwtIssuer;
  return handleOauthToken({ db, now, ip, issuerUrl }, request);
}
