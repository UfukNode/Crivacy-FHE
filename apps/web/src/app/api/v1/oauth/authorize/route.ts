/**
 * GET /api/v1/oauth/authorize, OAuth 2.0 authorization endpoint.
 *
 * Entry point for every firm redirecting a user into the Crivacy
 * consent flow. See `handleOauthAuthorize` for the full flow logic;
 * this file is only responsible for wiring Next.js → handler.
 */

import type { NextRequest } from 'next/server';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getDatabaseClient } from '@/lib/db/client';
import { extractClientIp } from '@/server/context';
import { handleOauthAuthorize } from '@/server/handlers/oauth-authorize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const db = getDatabaseClient().db;
  // IP + UA capture for the authorization_request row. `extractClientIp`
  // honours `AUTH_TRUSTED_PROXY_HOPS` + `CF-Connecting-IP` so a
  // hand-crafted `X-Forwarded-For` cannot move requests between
  // rate-limit buckets.
  const ip = extractClientIp(request);
  const userAgent = request.headers.get('user-agent');
  const now = new Date();

  // Per-IP rate limit, authorize is public and user-initiated so
  // the natural pivot is source IP. 30/min is well above any
  // legitimate user's click cadence while still cutting off
  // scripted enumeration.
  const limited = await maybeRateLimitResponse(db, 'oauth_authorize', ip, now);
  if (limited) return limited;

  return handleOauthAuthorize({ db, now, ip, userAgent }, request);
}
