/**
 * POST /api/v1/oauth/consent, record the user's approve/reject
 * decision for an in-flight authorize request and return the URL to
 * redirect the browser to next.
 *
 * Customer session required (cookie auth), the decision is bound to
 * the logged-in user, never to an anonymous session. The handler
 * itself lives in `handleOauthConsentDecision`; this file just wires
 * the route, authenticates the user, and parses the body.
 */

import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { lookupCustomer, lookupCustomerSession } from '@/lib/customer/lookup';
import { handleOauthConsentDecision } from '@/server/handlers/oauth-consent';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseBody } from '@/server/middleware/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  requestId: z.string().min(1).max(128),
  decision: z.enum(['approve', 'reject']),
});

export const POST = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  handler: async (ctx) => {
    // Per-customer cap, shields the consent cache + webhook fan-out
    // from a scripted approve/reject loop on a single account. IP
    // here is the caller-key slot; we pass `customer.id` because a
    // single shared IP (corporate NAT) may hold many users and we
    // want each user's limit independent.
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'oauth_consent_submit',
      ctx.customer.id,
      ctx.now,
    );
    if (limited !== null) return limited;

    const body = await parseBody(ctx.request, Body);
    // `ctx.ip` is already the canonical IP extraction (`AUTH_TRUSTED_PROXY_HOPS`
    // + `CF-Connecting-IP` precedence), no need for a second spoofable
    // raw `X-Forwarded-For` read here.
    const result = await handleOauthConsentDecision(
      {
        db: ctx.db,
        now: ctx.now,
        ip: ctx.ip,
        customerLabel: ctx.customer.email ?? ctx.customer.id,
        userAgent: ctx.userAgent ?? null,
        requestAuditId: ctx.requestId,
      },
      {
        requestId: body.requestId,
        userId: ctx.customer.id,
        decision: body.decision,
      },
    );
    return ctx.json(result);
  },
});
