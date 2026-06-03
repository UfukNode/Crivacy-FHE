/**
 * OAuth consent page, server-side bootstrap (direct call).
 *
 * Renders the consent card in a single pass. Instead of issuing an
 * HTTP self-fetch to `/api/v1/oauth/consent/bootstrap` with the
 * customer cookie forwarded, we resolve the same state in-process
 * via `resolveOauthConsentBootstrap`. Three wins:
 *
 *   1. **Host header is no longer an input.** The previous version
 *      synthesised an origin from the inbound `Host` +
 *      `X-Forwarded-Proto` headers. A reverse proxy that did not
 *      normalise `Host` let an attacker force the self-fetch to
 *      dial an arbitrary domain with the customer session cookie
 *      attached. Removing the self-fetch removes the class of bug.
 *   2. **No cookie forwarding over the wire.** The cookie stays on
 *      the browser; we never emit an outbound request carrying it.
 *   3. **First paint is the real card, no skeleton flash,** which
 *      was the original motivation for moving bootstrap to the
 *      server.
 *
 * Unauthenticated callers still bounce to `/login?from=…`, the
 * auth check is performed inline using the same JWT + session +
 * customer lookup pipeline the `customerRoute` middleware uses.
 */

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { CUSTOMER_ACCESS_COOKIE } from '@/lib/auth/cookie-names';
import { getAuthConfig } from '@/lib/auth/config';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { lookupCustomer, lookupCustomerSession } from '@/lib/customer/lookup';
import { getDatabaseClient } from '@/lib/db/client';
import { resolveOauthConsentBootstrap } from '@/server/handlers/oauth-bootstrap';

import ConsentClient from './consent-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ErrorShape {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

export default async function OauthConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string }>;
}) {
  const params = await searchParams;
  const requestId = params.request ?? null;

  if (requestId === null || requestId.length === 0) {
    notFound();
  }

  const cookieStore = await cookies();
  const continuePath = `/oauth/consent?request=${encodeURIComponent(requestId)}`;
  const loginRedirect = `/login?from=${encodeURIComponent(continuePath)}`;

  // --- 1. Auth ---------------------------------------------------------
  //
  // Mirror the customerRoute middleware pipeline, cookie → JWT →
  // session row → customer row, but inline so we can short-circuit
  // straight into a redirect on failure instead of composing a JSON
  // response. Any misstep (no cookie, expired token, revoked session,
  // deleted / suspended / locked / unverified customer) falls
  // through to the same `/login?from=…` bounce so the user ends up
  // on the login page without seeing a skeleton card or a JSON
  // 401.
  const rawCookie = cookieStore.get(CUSTOMER_ACCESS_COOKIE)?.value;
  if (rawCookie === undefined || rawCookie.length === 0) {
    redirect(loginRedirect);
  }

  const now = new Date();
  const db = getDatabaseClient().db;

  let authConfig: ReturnType<typeof getAuthConfig>;
  try {
    authConfig = getAuthConfig();
  } catch {
    return (
      <ConsentClient
        requestId={requestId}
        initialBootstrap={null}
        initialError={{
          code: 'internal_error',
          message: 'Auth config is not available. Please try again later.',
          status: 500,
        }}
      />
    );
  }

  let verifiedSub: string;
  let verifiedJti: string;
  try {
    const verified = await verifyAccessToken(rawCookie, authConfig, now);
    if (verified.kind !== 'customer') {
      redirect(loginRedirect);
    }
    verifiedSub = verified.sub;
    verifiedJti = verified.jti;
  } catch {
    redirect(loginRedirect);
  }

  const session = await lookupCustomerSession(db, verifiedJti);
  if (session === null || session.revokedAt !== null) {
    redirect(loginRedirect);
  }

  const customer = await lookupCustomer(db, verifiedSub);
  if (customer === null || customer.deletedAt !== null) {
    redirect(loginRedirect);
  }
  if (
    customer.status === 'banned' ||
    customer.status === 'suspended' ||
    customer.status === 'locked' ||
    customer.status === 'pending_verification'
  ) {
    // Same destination as the middleware: the login page renders
    // the status-specific error (banned / locked / verify-email)
    // and handles the copy, so redirecting here keeps the UX
    // consistent with every other customer-route entry point.
    redirect(loginRedirect);
  }

  // --- 2. Resolve bootstrap state directly ----------------------------
  //
  // In-process call, no HTTP, no origin synthesis, no cookie
  // forwarding. The resolver owns every shape the consent page
  // needs (request metadata, client branding, scope list, KYC
  // gate signals, cached-consent fast path) and returns either a
  // snapshot or a discriminated-union error.
  const outcome = await resolveOauthConsentBootstrap(
    {
      db,
      now,
      customer: {
        id: customer.id,
        email: customer.email,
        kycLevel: customer.kycLevel,
      },
    },
    requestId,
  );

  if (!outcome.ok) {
    const initialError: ErrorShape = {
      code: outcome.code,
      message: outcome.message,
      status: outcome.status,
    };
    return (
      <ConsentClient
        requestId={requestId}
        initialBootstrap={null}
        initialError={initialError}
      />
    );
  }

  return (
    <ConsentClient
      requestId={requestId}
      initialBootstrap={outcome.snapshot as never}
      initialError={null}
    />
  );
}
