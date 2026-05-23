/**
 * GET /api/v1/oauth/consent/bootstrap?request=<id>
 *
 * Thin wrapper around `resolveOauthConsentBootstrap`. All the
 * bootstrap logic (authorize-request lookup, ownership gate,
 * scope / KYC resolution, cached-consent fast path) lives in the
 * resolver so the server component that renders `/oauth/consent`
 * can drive the same logic directly without a self-fetch.
 *
 * Customer session required (cookie auth). Per-IP rate limit
 * shields this endpoint from fetch-in-a-loop scans.
 */

import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { lookupCustomer, lookupCustomerSession } from '@/lib/customer/lookup';
import { resolveOauthConsentBootstrap } from '@/server/handlers/oauth-bootstrap';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseQuery } from '@/server/middleware/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({
  request: z.string().min(1).max(128),
});

export const GET = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  handler: async (ctx) => {
    // Per-IP cap, bootstrap is cookie-gated but cheap to hammer;
    // 30/min is well above the one-call-per-page-load legitimate
    // pattern and kills a fetch-in-a-loop attack. `ctx.ip` already
    // carries the canonical IP extraction (`AUTH_TRUSTED_PROXY_HOPS`
    // + `CF-Connecting-IP` precedence) so a raw `X-Forwarded-For`
    // read here would only reintroduce the spoof vector.
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'oauth_consent_bootstrap',
      ctx.ip,
      ctx.now,
    );
    if (limited !== null) return limited;

    const { request: requestId } = parseQuery(new URL(ctx.request.url), Query);

    const outcome = await resolveOauthConsentBootstrap(
      {
        db: ctx.db,
        now: ctx.now,
        customer: {
          id: ctx.customer.id,
          email: ctx.customer.email,
          kycLevel: ctx.customer.kycLevel,
        },
      },
      requestId,
    );

    if (!outcome.ok) {
      return ctx.errorJson(outcome.code, outcome.message, outcome.status);
    }
    return ctx.json(outcome.snapshot);
  },
});
