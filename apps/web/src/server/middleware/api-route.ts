/**
 * API route builder — for firm-authenticated endpoints.
 *
 * Pipeline (every step can fail → early exit via error response):
 *
 *   1. Build `RequestContext` (requestId, db, now, ip, ua)
 *   2. Extract `X-API-Key` header → validate format
 *   3. Look up key by prefix → bcrypt verify → resolve firm → build
 *      `AuthenticatedContext`
 *   4. Check required scopes
 *   5. Apply rate limit (bucket + quota)
 *   6. If denied → 429 with structured body + headers
 *   7. Call handler
 *   8. On success → set rate-limit headers
 *   9. On error → map via error-mapper → `ctx.errorJson()`
 *
 * The builder uses the **dependency injection** pattern: every
 * external dependency (`authLookup`, `rateLimitFn`, `dbFactory`,
 * `clock`) is injected via the options object so tests can replace
 * them without importing a mock framework.
 *
 * Usage in a route file:
 * ```ts
 * export const POST = apiRoute({
 *   scopes: ['kyc:create'],
 *   handler: async (ctx) => {
 *     const body = await parseBody(ctx.request, SessionCreateRequest);
 *     return ctx.json(await createSession(ctx, body), 201);
 *   },
 * });
 * ```
 *
 * @module
 */

import { sql } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';

import type { ApiKeyMode, ApiKeyScope, FirmTier } from '@crivacy/shared-types';

import { getAuthConfig } from '@/lib/auth/config';
import { AuthError } from '@/lib/auth/errors';
import { hasRequiredScopes } from '@/lib/auth/scopes';
import {
  PLAYGROUND_TOKEN_HEADER,
  PlaygroundTokenError,
  verifyPlaygroundToken,
} from '@/lib/auth/playground-token';
import type { CrivacyDatabase } from '@/lib/db/client';
import { getDatabaseClient } from '@/lib/db/client';
import { recordAuthAttempt } from '@/lib/observability/request-metrics';

import {
  type AuthenticatedContext,
  type RateLimitSnapshot,
  type ResolvedApiKey,
  type ResolvedFirm,
  applyRateLimitHeaders,
  buildAuthenticatedContext,
  buildRequestContext,
} from '../context';
import { mapErrorToResponse } from './error-mapper';
import { ParseError } from './parse';
import { defaultApiRateLimitFn } from './rate-limit-default';

// ---------------------------------------------------------------------------
// Module-level defaults for the playground-token branch
// ---------------------------------------------------------------------------
//
// Every v1 route calls `apiRoute({ authLookup, ... })`; asking each one
// to also pass `playgroundKeyLookup` + `playgroundTokenSecret` would
// be boilerplate no caller can reason about in isolation. These cached
// defaults load the production repository + secret on first use and
// return them thereafter. Tests that want to pin either one pass it
// through the options and bypass this cache entirely.
//
// Lazy loading avoids a circular import chain on module evaluation —
// `./api-route` is imported by `@/server/repositories` transitively
// through the route builder consumers.

let cachedPlaygroundLookup: PlaygroundKeyLookupFn | null | undefined;
let cachedPlaygroundSecret: string | null | undefined;

async function loadDefaultPlaygroundLookup(): Promise<PlaygroundKeyLookupFn | null> {
  if (cachedPlaygroundLookup !== undefined) return cachedPlaygroundLookup;
  try {
    const mod = await import('../repositories/dashboard');
    cachedPlaygroundLookup = mod.resolveApiKeyByIdForPlayground;
  } catch {
    cachedPlaygroundLookup = null;
  }
  return cachedPlaygroundLookup;
}

function loadDefaultPlaygroundSecret(): string | null {
  if (cachedPlaygroundSecret !== undefined) return cachedPlaygroundSecret;
  try {
    cachedPlaygroundSecret = getAuthConfig().jwtSecret;
  } catch (err) {
    // `getAuthConfig` throws `AuthError('auth_config_invalid')` when
    // the env isn't wired up — treat that as "playground auth
    // unavailable" rather than crashing every `/api/v1/*` request.
    if (!(err instanceof AuthError)) throw err;
    cachedPlaygroundSecret = null;
  }
  return cachedPlaygroundSecret;
}

// ---------------------------------------------------------------------------
// DI interfaces
// ---------------------------------------------------------------------------

/**
 * The auth lookup function resolves an API key header into the
 * `(apiKey, firm)` tuple. Repositories implement this; the route
 * builder consumes it via DI.
 */
export type AuthLookupFn = (
  db: CrivacyDatabase,
  rawHeader: string,
) => Promise<{ apiKey: ResolvedApiKey; firm: ResolvedFirm }>;

/**
 * Resolve an API key + firm pair **by id only**, skipping the
 * raw-key → prefix → bcrypt chain. The playground-token branch of
 * the pipeline uses this after verifying the HMAC-signed token, so
 * the signature IS the credential. Returns `null` when the key is
 * revoked, expired, or does not belong to the firm named in the
 * token — the middleware treats that like an invalid api-key.
 */
export type PlaygroundKeyLookupFn = (
  db: CrivacyDatabase,
  keyId: string,
  firmId: string,
  now: Date,
) => Promise<{
  apiKey: {
    id: string;
    firmId: string;
    prefix: string;
    name: string;
    scopes: readonly string[];
    mode: string;
  };
  firm: {
    id: string;
    slug: string;
    displayName: string;
    tier: string;
    deletedAt: Date | null;
  };
} | null>;

/**
 * The rate limit function applies bucket + quota checks. Returns a
 * snapshot on allow, or a "denied" decision on throttle. The route
 * builder maps denied decisions to 429 responses.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
  readonly retryAfterSeconds?: number;
  readonly quotaLimit?: number;
  readonly quotaRemaining?: number;
  readonly quotaResetSeconds?: number;
}

export type RateLimitFn = (
  db: CrivacyDatabase,
  firmId: string,
  tier: string,
  now: Date,
) => Promise<RateLimitDecision>;

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

export type ApiHandler = (ctx: AuthenticatedContext) => Promise<NextResponse> | NextResponse;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ApiRouteOptions {
  /** Required scopes. Empty array = no scope check. */
  readonly scopes: readonly ApiKeyScope[];
  /** The handler to execute after auth + rate limit. */
  readonly handler: ApiHandler;
  /** Auth lookup — injected for testing. */
  readonly authLookup?: AuthLookupFn;
  /**
   * Playground-token key lookup — injected for testing. When omitted
   * the middleware rejects playground-token headers with 401 rather
   * than falling through to the regular api-key branch, so a
   * misconfigured route can't silently forget to support playground
   * auth.
   */
  readonly playgroundKeyLookup?: PlaygroundKeyLookupFn;
  /**
   * Secret used to verify playground tokens. Required whenever
   * `playgroundKeyLookup` is provided. Defaults to
   * `getAuthConfig().jwtSecret` via the route file, but the DI slot
   * stays explicit so tests supply a deterministic value.
   */
  readonly playgroundTokenSecret?: string;
  /** Rate limit — injected for testing. Set to `null` to skip. */
  readonly rateLimitFn?: RateLimitFn | null;
  /** DB factory — injected for testing. */
  readonly dbFactory?: () => CrivacyDatabase;
  /**
   * Factory for the NOBYPASSRLS handler pool — injected for testing.
   * Mirrors `dashboardRoute.appDbFactory` — handler work runs inside
   * a per-request transaction on this pool with `app.firm_id` set so
   * future RLS policies (phases 7-15) filter every row to the calling
   * firm. When omitted, defaults to the injected `dbFactory` (tests)
   * or the live `.app` pool (prod).
   */
  readonly appDbFactory?: () => CrivacyDatabase;
  /** Clock — injected for testing. */
  readonly clock?: () => Date;
  /** Request ID factory — injected for testing. */
  readonly requestIdFactory?: () => string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a Next.js App Router handler for a firm-authenticated
 * endpoint. All dependencies are injected via `options`.
 */
export function apiRoute(
  options: ApiRouteOptions,
): (request: NextRequest) => Promise<NextResponse> {
  const {
    scopes,
    handler,
    authLookup,
    playgroundKeyLookup,
    playgroundTokenSecret,
    dbFactory,
    appDbFactory,
    clock,
    requestIdFactory,
  } = options;

  // Distinguish "not provided" from "explicitly null". Only the
  // latter disables throttling — omission falls back to the default
  // firm-keyed limiter so new `/api/v1/*` routes get tier-aware
  // protection automatically.
  const rateLimitFn: RateLimitFn | null =
    options.rateLimitFn === undefined ? defaultApiRateLimitFn : options.rateLimitFn;

  const getDb = dbFactory ?? (() => getDatabaseClient().db);
  // See `dashboard-route.ts` for the RLS-pool rationale. Tests that
  // inject only `dbFactory` get the same mock for both slots.
  const getAppDb =
    appDbFactory ??
    (dbFactory === undefined ? (): CrivacyDatabase => getDatabaseClient().app : dbFactory);

  return async (request: NextRequest): Promise<NextResponse> => {
    const db = getDb();
    const baseCtx = buildRequestContext(request, db, clock, requestIdFactory);

    try {
      // --- 1. Resolve the authenticating credential ---
      //
      // Two mutually-exclusive authentication surfaces feed this
      // pipeline:
      //
      //   * a raw `x-api-key` header — the canonical public path
      //   * a signed `x-crivacy-playground-token` — used by the
      //     dashboard playground proxy. The HMAC signature is the
      //     credential; the named key id is loaded by id (not by
      //     bcrypt) because the dashboard can't store the raw key.
      //
      // Both paths end with the same `(apiKey, firm)` tuple so every
      // downstream stage (soft-delete check, scope check, rate
      // limiter, handler) stays auth-mode-agnostic.
      const rawKey = request.headers.get('x-api-key');
      const playgroundToken = request.headers.get(PLAYGROUND_TOKEN_HEADER);

      if (rawKey !== null && rawKey.length > 0 && playgroundToken !== null && playgroundToken.length > 0) {
        return baseCtx.errorJson(
          'invalid_request',
          'Playground token and API key are mutually exclusive.',
          400,
        );
      }

      let apiKey: ResolvedApiKey;
      let firm: ResolvedFirm;

      if (playgroundToken !== null && playgroundToken.length > 0) {
        // --- 1a. Playground-token path ---
        //
        // Tokens are short-lived HMAC values minted by the dashboard's
        // playground proxy. Every v1 route accepts them transparently
        // via module-level defaults; tests can still pin both DI
        // slots to deterministic values.
        const lookupFn = playgroundKeyLookup ?? (await loadDefaultPlaygroundLookup());
        const secret = playgroundTokenSecret ?? loadDefaultPlaygroundSecret();
        if (lookupFn === null || secret === null) {
          // Defaults unavailable (e.g. AUTH_JWT_SECRET missing, or
          // repository import failed). Treat like invalid auth —
          // same response as a missing api key so misconfigured
          // deployments don't leak diagnostic detail.
          recordAuthAttempt('api_key', 'failure');
          return baseCtx.errorJson(
            'unauthenticated',
            'Playground authentication is not available on this deployment.',
            401,
          );
        }
        let payload;
        try {
          payload = verifyPlaygroundToken(playgroundToken, secret, baseCtx.now);
        } catch (err) {
          if (err instanceof PlaygroundTokenError) {
            recordAuthAttempt('api_key', 'failure');
            return baseCtx.errorJson('invalid_api_key', err.message, 401);
          }
          throw err;
        }
        const resolved = await lookupFn(db, payload.k, payload.f, baseCtx.now);
        if (resolved === null) {
          recordAuthAttempt('api_key', 'failure');
          return baseCtx.errorJson(
            'invalid_api_key',
            'API key named by playground token is revoked, expired, or unknown.',
            401,
          );
        }
        apiKey = resolved.apiKey as ResolvedApiKey;
        firm = resolved.firm as ResolvedFirm;
      } else {
        // --- 1b. Canonical x-api-key path ---
        if (rawKey === null || rawKey.length === 0) {
          recordAuthAttempt('api_key', 'failure');
          return baseCtx.errorJson('unauthenticated', 'Missing X-API-Key header.', 401);
        }
        if (authLookup === undefined) {
          // Without an auth lookup, we cannot authenticate. This is a
          // programmer error — every apiRoute must provide one in
          // production. In tests, the mock is always injected.
          return baseCtx.errorJson('internal_error', 'Auth lookup not configured.', 500);
        }
        try {
          const lookup = await authLookup(db, rawKey);
          apiKey = lookup.apiKey;
          firm = lookup.firm;
        } catch (err) {
          // `authLookup` rejects with an `AuthError` on bad / unknown
          // key — that's the canonical failure path. Record it here
          // so the outer catch's generic error mapping does not need
          // to know about the metric. Anything that isn't a known
          // auth failure is rethrown to the outer handler, which maps
          // it to an `internal_error` and leaves the metric alone.
          if (err instanceof AuthError) {
            recordAuthAttempt('api_key', 'failure');
          }
          throw err;
        }
      }

      // --- 3. Soft-deleted firm check ---
      if (firm.deletedAt !== null) {
        recordAuthAttempt('api_key', 'failure');
        return baseCtx.errorJson('unauthenticated', 'This firm has been deactivated.', 401);
      }

      // --- 4. Scope check ---
      if (!hasRequiredScopes(apiKey.scopes, scopes)) {
        recordAuthAttempt('api_key', 'failure');
        return baseCtx.errorJson(
          'scope_forbidden',
          `This API key does not have the required scope(s): ${scopes.join(', ')}.`,
          403,
        );
      }

      // Auth OK at this point. Scope + rate-limit failures below are
      // authorization-layer denials, not authentication-layer ones, so
      // they do not record into the auth metric.
      recordAuthAttempt('api_key', 'success');

      // --- 5. Rate limit ---
      let snapshot: RateLimitSnapshot | null = null;

      if (rateLimitFn !== undefined && rateLimitFn !== null) {
        try {
          const decision = await rateLimitFn(db, firm.id, firm.tier, baseCtx.now);

          if (!decision.allowed) {
            const retryAfter = decision.retryAfterSeconds ?? decision.resetSeconds;
            const response = baseCtx.errorJson(
              'rate_limited',
              'Rate limit exceeded. Please retry later.',
              429,
              {
                retry_after_seconds: retryAfter,
                limit: decision.limit,
                remaining: decision.remaining,
                reset: decision.resetSeconds,
              },
              retryAfter,
            );
            return applyRateLimitHeaders(response, {
              limit: decision.limit,
              remaining: decision.remaining,
              resetSeconds: decision.resetSeconds,
            });
          }

          snapshot = {
            limit: decision.limit,
            remaining: decision.remaining,
            resetSeconds: decision.resetSeconds,
          };
        } catch {
          // Rate limit internal error → allow the request through
          // (fail-open for availability). Snapshot stays null.
        }
      }

      // --- 6. Build authenticated context ---
      // --- 7. RLS-scoped transaction + handler ---
      //
      // Identical shape to `dashboardRoute` phase 2 — every handler
      // call runs inside a per-request tx on the NOBYPASSRLS pool with
      // `app.firm_id` set to the caller's firm id. Pre-auth work
      // (api-key lookup, scope check, rate limit) above keeps running
      // on the admin pool via `db` because those queries span tables
      // regardless of firm (scope catalog, rate-limit events).
      const appDb = getAppDb();
      return await appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.firm_id', ${firm.id}, true)`);
        const ctx = buildAuthenticatedContext(
          { ...baseCtx, db: tx as CrivacyDatabase },
          apiKey,
          firm,
          snapshot,
        );
        const response = await handler(ctx);
        return applyRateLimitHeaders(response, snapshot);
      });
    } catch (err) {
      if (err instanceof ParseError) {
        const status =
          err.code === 'payload_too_large'
            ? 413
            : err.code === 'unsupported_media_type'
              ? 415
              : 400;
        return baseCtx.errorJson(err.code, err.message, status);
      }
      const mapped = mapErrorToResponse(err);
      return baseCtx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
    }
  };
}
