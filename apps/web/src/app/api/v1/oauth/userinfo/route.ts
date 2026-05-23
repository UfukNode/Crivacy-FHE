/**
 * GET /api/v1/oauth/userinfo, OIDC userinfo endpoint.
 *
 * Authenticated via `Authorization: Bearer <access_token>` issued by
 * `/api/v1/oauth/token`. Returns the scope-limited claim set for the
 * user the token was issued for.
 */

import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getDatabaseClient } from '@/lib/db/client';
import { extractClientIp } from '@/server/context';
import { handleOauthUserinfo } from '@/server/handlers/oauth-userinfo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const db = getDatabaseClient().db;
  const now = new Date();
  // Routed through the canonical IP extractor. Used for the
  // `oauth.userinfo_first_use` audit row and as the rate-limit
  // fallback when no Bearer token is present on the request.
  const ip = extractClientIp(request);

  // Per-token rate-limit: a leaked bearer being sprayed gets capped
  // at 60/min regardless of which IP is firing. Key is a SHA-256
  // digest of the raw token, we never store or compare the raw
  // value here, just in case a log swallows the caller-key. Falls
  // back to IP when the Authorization header is missing / malformed
  // so unauthed probes also face a ceiling.
  let rateLimitKey: string | null = ip;
  const authHeader = request.headers.get('authorization');
  if (authHeader !== null && authHeader.toLowerCase().startsWith('bearer ')) {
    const rawToken = authHeader.slice('bearer '.length).trim();
    if (rawToken.length > 0) {
      rateLimitKey = createHash('sha256').update(rawToken, 'utf8').digest('hex');
    }
  }
  const limited = await maybeRateLimitResponse(db, 'oauth_userinfo', rateLimitKey, now);
  if (limited !== null) return limited;

  return handleOauthUserinfo({ db, now, ip }, request);
}
