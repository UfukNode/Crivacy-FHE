/**
 * Request context — the typed bag that flows through every handler.
 *
 * Three tiers:
 *
 *   1. `RequestContext` — base context for every request (health, status,
 *      inbound webhooks). Contains the request id, clock, DB handle, and
 *      transport metadata but no authentication.
 *
 *   2. `AuthenticatedContext` — extends the base with a resolved API key
 *      and firm. Every firm-facing (`/api/v1/*`) route handler receives
 *      this; the middleware pipeline builds it by looking up the key and
 *      firm in the database and verifying the bcrypt hash.
 *
 *   3. Response helpers (`json`, `noContent`, `errorJson`) are attached to
 *      the context so the handler does not import Next.js types directly —
 *      keeping it framework-free and trivially testable.
 *
 * All shapes are `readonly` + `Object.freeze`d at construction so a
 * handler cannot mutate shared middleware state.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import type { ApiKeyMode, ApiKeyScope, FirmTier } from '@crivacy/shared-types';

import type { CrivacyDatabase } from '@/lib/db/client';

// ---------------------------------------------------------------------------
// Resolved DB entities
// ---------------------------------------------------------------------------

/**
 * Shape of an API key after the auth middleware has:
 *   1. looked it up by prefix
 *   2. verified the raw key against the stored bcrypt hash
 *   3. parsed the `scopes text[]` column via `parseScopes()`
 *
 * The handler never sees the hash itself — only the metadata it needs.
 */
export interface ResolvedApiKey {
  readonly id: string;
  readonly firmId: string;
  readonly prefix: string;
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly mode: ApiKeyMode;
}

/**
 * Shape of a firm after the auth middleware has resolved it from the
 * API key's `firm_id` FK. `deletedAt` is exposed so the middleware
 * can reject requests to soft-deleted firms with a clear error.
 */
export interface ResolvedFirm {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly tier: FirmTier;
  readonly deletedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Rate limit snapshot (attached after applyRateLimit)
// ---------------------------------------------------------------------------

/**
 * Subset of the rate-limit decision that handlers and response builders
 * need. The full `RateLimitDecision` from `@/lib/ratelimit` carries more
 * internal state; this is the public surface the context exposes.
 */
export interface RateLimitSnapshot {
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
}

// ---------------------------------------------------------------------------
// Base request context
// ---------------------------------------------------------------------------

/**
 * Built by the middleware pipeline for every request — before any
 * authentication. Health and status endpoints receive only this.
 */
export interface RequestContext {
  /** UUID v4, unique per request, set in the `X-Request-Id` response header. */
  readonly requestId: string;

  /** Database handle — the process-level singleton from `getDatabaseClient()`. */
  readonly db: CrivacyDatabase;

  /** Clock snapshot frozen at request start. All date comparisons use this. */
  readonly now: Date;

  /** `performance.now()` at request start — used for latency measurement. */
  readonly startedAt: number;

  /** Client IP from `x-forwarded-for` or socket address; null if unresolvable. */
  readonly ip: string | null;

  /** Raw `user-agent` header; null if absent. */
  readonly userAgent: string | null;

  /** HTTP method — `GET`, `POST`, `DELETE`, `PATCH`. */
  readonly method: string;

  /** Pathname without query string — `/api/v1/sessions`. */
  readonly path: string;

  /** The original Next.js request — passed through for body/header access. */
  readonly request: NextRequest;

  /** Return a JSON response with the given status. */
  readonly json: <T>(body: T, status?: number) => NextResponse;

  /** Return a 204 No Content response. */
  readonly noContent: () => NextResponse;

  /**
   * Return a structured error JSON response.
   *
   * Pass `retryAfterSeconds` when the response status is 429 — the
   * helper sets the standard `Retry-After` header (RFC 6585) so HTTP
   * clients and intermediaries back off for the indicated cooldown.
   */
  readonly errorJson: (
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
    retryAfterSeconds?: number,
  ) => NextResponse;
}

// ---------------------------------------------------------------------------
// Authenticated context (extends base)
// ---------------------------------------------------------------------------

/**
 * Extended context for firm-facing routes. The auth middleware populates
 * `apiKey` and `firm` before the handler runs; the rate-limit middleware
 * populates `rateLimit` (if applicable).
 */
export interface AuthenticatedContext extends RequestContext {
  /** The API key that authenticated this request. */
  readonly apiKey: ResolvedApiKey;

  /** The firm that owns the API key. */
  readonly firm: ResolvedFirm;

  /** Rate limit state after `applyRateLimit` — null on internal error fallback. */
  readonly rateLimit: RateLimitSnapshot | null;
}

// ---------------------------------------------------------------------------
// Dashboard context (JWT session-based)
// ---------------------------------------------------------------------------

/**
 * Shape of a resolved firm user after JWT verification + session lookup.
 */
export interface ResolvedDashboardUser {
  readonly id: string;
  readonly firmId: string;
  readonly email: string;
  readonly role: 'owner' | 'admin' | 'member' | 'viewer';
}

/**
 * Extended context for dashboard/internal routes. The JWT middleware
 * verifies the access token from the `Authorization: Bearer <token>`
 * header or `__crivacy_at` cookie, looks up the session row, and
 * populates `user` and `session`.
 */
export interface DashboardContext extends RequestContext {
  /** The authenticated firm user. */
  readonly user: ResolvedDashboardUser;
  /** The firm that the user belongs to. */
  readonly firm: ResolvedFirm;
  /** JWT session metadata. */
  readonly session: {
    readonly sessionId: string;
    readonly jti: string;
    readonly kind: 'firm';
  };
  /**
   * Effective permission set for the authenticated firm user, resolved
   * once per request via `resolveEffectivePermissions`. Handlers that
   * need target-type guards (e.g. "Admin cannot change Owner role")
   * read this set directly via `hasPermission(ctx.permissions, ...)`
   * instead of re-querying. Safe to pass across async boundaries —
   * the set is frozen at context construction.
   */
  readonly permissions: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Admin context (JWT session-based, no firm)
// ---------------------------------------------------------------------------

/**
 * Shape of a resolved admin user after JWT verification + session lookup.
 */
export interface ResolvedAdminUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'superadmin' | 'admin' | 'support';
}

/**
 * Extended context for admin/internal routes. The JWT middleware verifies
 * the access token, checks `kind === 'admin'`, looks up the admin_users
 * row, verifies IP allowlist, and populates `user` and `session`.
 */
export interface AdminContext extends RequestContext {
  /** The authenticated admin user. */
  readonly user: ResolvedAdminUser;
  /** JWT session metadata. */
  readonly session: {
    readonly sessionId: string;
    readonly jti: string;
    readonly kind: 'admin';
  };
  /**
   * Effective permission set for the authenticated admin user. See
   * `DashboardContext.permissions` — same contract, same guarantees.
   * Handler-level target-type guards (e.g. "Admin cannot update a
   * Superadmin's profile") consume this instead of re-querying.
   */
  readonly permissions: ReadonlySet<string>;
}

/**
 * Build an AdminContext after JWT verification.
 */
export function buildAdminContext(
  base: RequestContext,
  user: ResolvedAdminUser,
  session: AdminContext['session'],
  permissions: ReadonlySet<string>,
): AdminContext {
  const ctx: AdminContext = {
    ...base,
    user: Object.freeze(user),
    session: Object.freeze(session),
    permissions,
  };
  return Object.freeze(ctx);
}

/**
 * Build a DashboardContext after JWT verification.
 */
export function buildDashboardContext(
  base: RequestContext,
  user: ResolvedDashboardUser,
  firm: ResolvedFirm,
  session: DashboardContext['session'],
  permissions: ReadonlySet<string>,
): DashboardContext {
  const ctx: DashboardContext = {
    ...base,
    user: Object.freeze(user),
    firm: Object.freeze(firm),
    session: Object.freeze(session),
    permissions,
  };
  return Object.freeze(ctx);
}

// ---------------------------------------------------------------------------
// Customer context (JWT session-based)
// ---------------------------------------------------------------------------

/**
 * Shape of a resolved customer after JWT verification + session lookup.
 */
export interface ResolvedCustomer {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly status: 'pending_verification' | 'active' | 'suspended' | 'locked' | 'banned';
  readonly kycLevel: string;
  readonly kycScore: number;
  /**
   * Set when the Didit user-entity webhook (Batch E) revokes the
   * customer's verification — `user.data.updated` with `deleted_at`
   * or `user.status.updated` with `BLOCKED`/`Declined`. Drives the
   * start-identity / start-address 409 guard so a stale tab from
   * before the revoke cannot silently start a new session. Distinct
   * from soft-delete (`customers.deletedAt`).
   */
  readonly revokedAt: Date | null;
  /**
   * Per-customer decline counter — bumped on every Didit decline,
   * reset to 0 on approval (atomic with the level/score bump).
   * Read by the start-* gate via `evaluateDeclineLock` to short-
   * circuit BEFORE going to Didit when the customer has burned
   * through the decline cap inside the cooldown window. See
   * `lib/fraud/decline-counter.ts` for the SoT.
   */
  readonly consecutiveKycDeclines: number;
  /**
   * Paired anchor for `consecutiveKycDeclines` — UTC timestamp of
   * the most recent decline. The cooldown window is computed from
   * this; a customer who waits past the cooldown naturally regains
   * start-session access without admin intervention.
   */
  readonly lastDeclineAt: Date | null;
}

/**
 * Extended context for customer-facing routes. The JWT middleware verifies
 * the access token from the `__crivacy_ct` cookie, looks up the
 * customer_sessions row, and populates `customer` and `session`.
 */
export interface CustomerContext extends RequestContext {
  /** The authenticated customer. */
  readonly customer: ResolvedCustomer;
  /** JWT session metadata. */
  readonly session: {
    readonly sessionId: string;
    readonly jti: string;
    readonly kind: 'customer';
  };
}

/**
 * Build a CustomerContext after JWT verification.
 */
export function buildCustomerContext(
  base: RequestContext,
  customer: ResolvedCustomer,
  session: CustomerContext['session'],
): CustomerContext {
  const ctx: CustomerContext = {
    ...base,
    customer: Object.freeze(customer),
    session: Object.freeze(session),
  };
  return Object.freeze(ctx);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const MAX_IP_LENGTH = 45; // IPv6 max string length
const MAX_UA_LENGTH = 1024;

/**
 * Resolve the trusted-proxy-hop count from env once per process.
 * `AUTH_TRUSTED_PROXY_HOPS=N` means "the last N entries in
 * `X-Forwarded-For` were added by proxies WE operate (e.g. our
 * load balancer + CDN), so the real client IP is the one just
 * before them."
 *
 * Behaviour when the env is missing / malformed:
 *   - **Production** (`NODE_ENV=production`): throw. Silent fallback
 *     to the client-controlled leftmost `X-Forwarded-For` entry would
 *     render every IP-based guard (rate limit, OAuth code IP binding,
 *     fraud signals) end-to-end spoofable, and the previous one-shot
 *     console warning proved too easy to miss in log aggregators.
 *     Fail-loud at first request — the platform healthcheck will
 *     catch the crash and the deploy gets flagged instead of silently
 *     shipping a broken trust chain. Pairs with PROD-TODO madde 4.
 *   - **Non-production**: fall through to legacy leftmost parsing so
 *     tests, dev servers, and local curl commands keep working without
 *     needing the env set.
 */
let cachedTrustedProxyHops: number | null | undefined;

function getTrustedProxyHops(): number | null {
  if (cachedTrustedProxyHops !== undefined) return cachedTrustedProxyHops;
  const raw = process.env['AUTH_TRUSTED_PROXY_HOPS'];
  if (raw === undefined || raw.trim().length === 0) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        '[context] AUTH_TRUSTED_PROXY_HOPS is not set. In production this' +
          ' env MUST be an integer matching the number of trusted proxies in' +
          ' front of this instance (e.g. 1 for a single Cloudflare / NGINX' +
          ' hop). Without it, IP-based guards (rate limit, OAuth code IP' +
          ' binding, fraud signals) are end-to-end spoofable. Set the env' +
          ' and redeploy.',
      );
    }
    cachedTrustedProxyHops = null;
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    cachedTrustedProxyHops = null;
    return null;
  }
  cachedTrustedProxyHops = parsed;
  return parsed;
}

/** Test-only helper — drop the memoised env read so per-case overrides apply. */
export function resetTrustedProxyConfigForTests(): void {
  cachedTrustedProxyHops = undefined;
}

function acceptIpValue(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IP_LENGTH) return null;
  return trimmed;
}

/**
 * Extract the client IP from the request, honouring the configured
 * trust model so IP-based guards (rate limit, OAuth code IP
 * binding, fraud signals) cannot be spoofed end-to-end.
 *
 * Priority:
 *
 *   1. `CF-Connecting-IP`. Cloudflare sets this at the edge on every
 *      proxied request and strips any client-supplied copy before it
 *      reaches the origin. When it's present, it's authoritative.
 *
 *   2. Strict right-parse of `X-Forwarded-For` when
 *      `AUTH_TRUSTED_PROXY_HOPS=N` is configured. `N` is the number
 *      of proxies between the public internet and this process; the
 *      helper takes the entry `N` positions from the *right*, which
 *      is the last hop beyond our trust boundary — i.e. the real
 *      client IP. Anything to the right of that was added by our
 *      own infrastructure and we trust it; anything to the left is
 *      attacker-controlled and we ignore it.
 *
 *   3. `X-Real-IP` as a fallback, but only when the strict-parse
 *      trust chain is configured — same argument. Covers NGINX
 *      `real_ip_header X-Real-IP` deployments.
 *
 *   4. Legacy leftmost `X-Forwarded-For` fallback when no trust
 *      config is set. This is the historical behaviour and is
 *      retained so dev environments and tests continue to work,
 *      but a prod deployment without `AUTH_TRUSTED_PROXY_HOPS` is
 *      insecure and emits a one-shot console warning via
 *      `getTrustedProxyHops`.
 *
 *   5. `null` when nothing looks usable. Downstream guards fail
 *      open on null, which is the right default — blocking every
 *      request on a transient header miss would be worse than
 *      admitting a small cohort of untrackable requests.
 */
export function extractClientIp(request: NextRequest): string | null {
  // 1. Cloudflare-set, spoof-proof.
  const cf = acceptIpValue(request.headers.get('cf-connecting-ip'));
  if (cf !== null) return cf;

  const forwardedRaw = request.headers.get('x-forwarded-for');
  const realIp = acceptIpValue(request.headers.get('x-real-ip'));
  const trustedHops = getTrustedProxyHops();

  // 2 & 3. Strict-parse path — only when we know how deep the
  // trust chain is.
  if (trustedHops !== null) {
    if (forwardedRaw !== null && forwardedRaw.length > 0) {
      const entries = forwardedRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // `entries.length - 1 - trustedHops` walks left from the
      // rightmost entry past our own proxies. trustedHops === 0
      // means "no proxy we trust; pick the rightmost entry (the
      // hop that handed the request to us directly)".
      const idx = entries.length - 1 - trustedHops;
      if (idx >= 0) {
        const candidate = acceptIpValue(entries[idx] ?? null);
        if (candidate !== null) return candidate;
      }
    }
    if (realIp !== null) return realIp;
    return null;
  }

  // 4. Legacy leftmost fallback. Documented as insecure; console
  // warning above makes the drift visible in prod.
  if (forwardedRaw !== null && forwardedRaw.length > 0) {
    const first = acceptIpValue(forwardedRaw.split(',')[0] ?? null);
    if (first !== null) return first;
  }
  if (realIp !== null) return realIp;
  return null;
}

/**
 * Extract the user-agent header, truncated to 1024 chars.
 */
export function extractUserAgent(request: NextRequest): string | null {
  const ua = request.headers.get('user-agent');
  if (ua === null || ua.length === 0) {
    return null;
  }
  return ua.length > MAX_UA_LENGTH ? ua.slice(0, MAX_UA_LENGTH) : ua;
}

/**
 * Build a response helper set that carries the given `requestId` on every
 * response via `X-Request-Id`. These closures are attached to the context
 * so handlers stay framework-free.
 */
export function buildResponseHelpers(requestId: string) {
  const baseHeaders: Record<string, string> = {
    'x-request-id': requestId,
    'cache-control': 'no-store',
  };

  return {
    json: <T>(body: T, status = 200): NextResponse => {
      return NextResponse.json(body, { status, headers: baseHeaders });
    },

    noContent: (): NextResponse => {
      return new NextResponse(null, { status: 204, headers: baseHeaders });
    },

    errorJson: (
      code: string,
      message: string,
      status: number,
      details?: Record<string, unknown>,
      retryAfterSeconds?: number,
    ): NextResponse => {
      const body = {
        error: {
          code,
          message,
          requestId,
          ...(details !== undefined ? { details } : {}),
        },
      };
      const headers: Record<string, string> = { ...baseHeaders };
      if (retryAfterSeconds !== undefined) {
        // RFC 6585 §4 — `Retry-After` MUST accompany 429 so clients
        // and intermediaries back off for the indicated cooldown.
        // Floor to a whole second; clients only honour delta-seconds.
        const seconds = Math.max(0, Math.ceil(retryAfterSeconds));
        headers['Retry-After'] = String(seconds);
      }
      return NextResponse.json(body, { status, headers });
    },
  } as const;
}

/**
 * Build the base `RequestContext` from a Next.js request. Call this at
 * the very start of the middleware pipeline.
 */
export function buildRequestContext(
  request: NextRequest,
  db: CrivacyDatabase,
  clock: () => Date = () => new Date(),
  requestIdFactory: () => string = () => crypto.randomUUID(),
): RequestContext {
  const requestId = requestIdFactory();
  const now = clock();
  const url = new URL(request.url);
  const helpers = buildResponseHelpers(requestId);

  const ctx: RequestContext = {
    requestId,
    db,
    now,
    startedAt: performance.now(),
    ip: extractClientIp(request),
    userAgent: extractUserAgent(request),
    method: request.method,
    path: url.pathname,
    request,
    json: helpers.json,
    noContent: helpers.noContent,
    errorJson: helpers.errorJson,
  };

  return Object.freeze(ctx);
}

/**
 * Extend a base `RequestContext` into an `AuthenticatedContext` after
 * the auth middleware has resolved the API key and firm.
 */
export function buildAuthenticatedContext(
  base: RequestContext,
  apiKey: ResolvedApiKey,
  firm: ResolvedFirm,
  rateLimit: RateLimitSnapshot | null,
): AuthenticatedContext {
  const ctx: AuthenticatedContext = {
    ...base,
    apiKey: Object.freeze(apiKey),
    firm: Object.freeze(firm),
    rateLimit: rateLimit !== null ? Object.freeze(rateLimit) : null,
  };

  return Object.freeze(ctx);
}

/**
 * Add rate-limit headers to a response. Called by the API route builder
 * after the handler returns, using the snapshot from the context.
 */
export function applyRateLimitHeaders(
  response: NextResponse,
  snapshot: RateLimitSnapshot | null,
): NextResponse {
  if (snapshot === null) {
    return response;
  }
  response.headers.set('x-ratelimit-limit', String(snapshot.limit));
  response.headers.set('x-ratelimit-remaining', String(snapshot.remaining));
  response.headers.set('x-ratelimit-reset', String(snapshot.resetSeconds));
  return response;
}
