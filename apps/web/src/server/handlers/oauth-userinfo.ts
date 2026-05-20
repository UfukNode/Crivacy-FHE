/**
 * OAuth /userinfo handler — resolve a bearer access token into its
 * claim set.
 *
 * The firm sends `Authorization: Bearer <token>`; we hash, look up
 * the opaque token, check validity (expiry, revocation), update
 * `last_used_at` fire-and-forget, then return a flat JSON payload
 * mirroring the id_token claims that were issued against the same
 * scope.
 *
 * The response shape is OIDC-compliant (RFC `userinfo` endpoint):
 * `{ sub, ...custom_claims }`. No JWT signing; this response is
 * meant to be called over TLS with the short-lived bearer.
 *
 * @module
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { systemActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import type { CrivacyDatabase } from '@/lib/db/client';
import { hashAccessToken, parseScope, toOauthClaims } from '@/lib/oauth';
import { findAccessToken, touchAccessToken } from '@/server/repositories';

import { findActiveCredentialForUser } from './oauth-shared';

export interface OauthUserinfoDeps {
  readonly db: CrivacyDatabase;
  readonly now: Date;
  /** Caller IP (first x-forwarded-for hop) — used in the audit row. */
  readonly ip?: string | null;
}

function userinfoError(
  code: string,
  description: string,
  status: number,
): NextResponse {
  // RFC 6750 §3.1 — userinfo errors travel via WWW-Authenticate
  // when we can, but the JSON body is the authoritative signal for
  // clients that ignore the header.
  return NextResponse.json(
    { error: code, error_description: description },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'WWW-Authenticate': `Bearer error="${code}", error_description="${description.replace(/"/g, '')}"`,
      },
    },
  );
}

export async function handleOauthUserinfo(
  deps: OauthUserinfoDeps,
  request: NextRequest,
): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (authHeader === null || !authHeader.toLowerCase().startsWith('bearer ')) {
    return userinfoError('invalid_request', 'Bearer token required.', 401);
  }
  const rawToken = authHeader.slice('bearer '.length).trim();
  if (rawToken.length === 0) {
    return userinfoError('invalid_request', 'Bearer token is empty.', 401);
  }

  const tokenHash = hashAccessToken(rawToken);

  // Per-token rate limit — keyed on the access-token hash rather
  // than source IP. A legitimate firm backend may call /userinfo
  // from the same IP for thousands of different users, so per-IP
  // would either starve them or pass them through. Per-token caps
  // a leaked-token spray (or a buggy firm integration that loops
  // over userinfo for the same user) at 60/min.
  const limited = await maybeRateLimitResponse(
    deps.db,
    'oauth_userinfo',
    tokenHash,
    deps.now,
  );
  if (limited) return limited;

  const tokenRow = await findAccessToken(deps.db, tokenHash);
  if (tokenRow === null) {
    return userinfoError('invalid_token', 'Access token is unknown.', 401);
  }
  if (tokenRow.revokedAt !== null) {
    return userinfoError('invalid_token', 'Access token has been revoked.', 401);
  }
  if (tokenRow.expiresAt.getTime() <= deps.now.getTime()) {
    return userinfoError('invalid_token', 'Access token has expired.', 401);
  }

  // Audit the FIRST time a freshly-issued token lands here. We gate
  // on `lastUsedAt === null` so a high-traffic firm doesn't flood
  // the audit table on every subsequent /userinfo call — the SOC
  // only needs one "token went live" stamp per consent; downstream
  // usage is covered by the per-row `last_used_at` column. The
  // whole block is wrapped in try/catch because the audit target
  // builder throws on invalid ids, and an observability failure
  // must never break the auth path (the token is already valid;
  // logging is a side channel).
  if (tokenRow.lastUsedAt === null) {
    try {
      void writeAudit(deps.db, {
        action: 'oauth.userinfo_first_use',
        actor: systemActor('oauth-userinfo'),
        target: uuidTarget({ kind: 'oauth_consent', id: tokenRow.consentId }),
        context: buildAuditRequestContext({
          ip: deps.ip ?? null,
          userAgent: request.headers.get('user-agent'),
          requestId: null,
        }),
        meta: {
          clientUuid: tokenRow.clientId,
          userId: tokenRow.userId,
          scope: tokenRow.scope,
          tokenExpiresAt: tokenRow.expiresAt.toISOString(),
        },
        ts: deps.now,
      }).catch(() => undefined);
    } catch {
      // Swallow — audit plumbing issues must not break the
      // response. The missed row is a monitoring gap, not a
      // correctness concern.
    }
  }

  // Fire-and-forget `last_used_at` touch; don't block the response
  // on it. A missed touch only costs us a stale observability
  // signal, not correctness.
  void touchAccessToken(deps.db, tokenRow.tokenHash, deps.now).catch(() => undefined);

  const scopes = parseScope(tokenRow.scope);
  const view = await findActiveCredentialForUser(deps.db, tokenRow.userId);
  const claims = toOauthClaims({
    userId: tokenRow.userId,
    view,
    scopes,
  });

  return NextResponse.json(claims, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}
