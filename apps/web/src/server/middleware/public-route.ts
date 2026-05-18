/**
 * Public route builder — for unauthenticated endpoints like health and
 * status.
 *
 * Pipeline:
 *   1. Build `RequestContext` (requestId, db, now, ip, ua)
 *   2. Call handler
 *   3. On success → set `X-Request-Id` header (already on the response
 *      via `buildResponseHelpers`)
 *   4. On error → map via error-mapper → `ctx.errorJson()`
 *
 * Usage in a route file:
 * ```ts
 * export const GET = publicRoute(async (ctx) => {
 *   return ctx.json({ status: 'ok' });
 * });
 * ```
 *
 * @module
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';

import type { CrivacyDatabase } from '@/lib/db/client';
import { getDatabaseClient } from '@/lib/db/client';

import { type RequestContext, buildRequestContext } from '../context';
import { mapErrorToResponse } from './error-mapper';
import { ParseError } from './parse';

/**
 * Handler function signature for public routes.
 */
export type PublicHandler = (ctx: RequestContext) => Promise<NextResponse> | NextResponse;

/**
 * Build a Next.js App Router handler for a public (unauthenticated)
 * endpoint.
 *
 * DI hooks (`dbFactory`, `clock`, `requestIdFactory`) are exposed for
 * testing — production callers never pass them.
 */
export function publicRoute(
  handler: PublicHandler,
  options?: {
    readonly dbFactory?: () => CrivacyDatabase;
    readonly clock?: () => Date;
    readonly requestIdFactory?: () => string;
  },
): (request: NextRequest) => Promise<NextResponse> {
  const getDb = options?.dbFactory ?? (() => getDatabaseClient().db);
  const clock = options?.clock;
  const requestIdFactory = options?.requestIdFactory;

  return async (request: NextRequest): Promise<NextResponse> => {
    const db = getDb();
    const ctx = buildRequestContext(request, db, clock, requestIdFactory);

    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof ParseError) {
        const status =
          err.code === 'payload_too_large'
            ? 413
            : err.code === 'unsupported_media_type'
              ? 415
              : 400;
        return ctx.errorJson(err.code, err.message, status);
      }
      const mapped = mapErrorToResponse(err);
      return ctx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
    }
  };
}
