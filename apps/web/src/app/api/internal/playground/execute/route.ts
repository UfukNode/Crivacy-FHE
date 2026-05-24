/**
 * POST /api/internal/playground/execute, proxy an API v1 request
 *
 * Authenticated via dashboard JWT. The user selects an API key
 * belonging to their firm, and the playground proxies the request
 * to the real v1 endpoint with that key.
 */

import { z } from 'zod';

import { firmUserActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { getAuthConfig } from '@/lib/auth/config';
import { handlePlaygroundExecute } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findApiKeyForPlayground,
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PlaygroundBody = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(2048),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  apiKeyId: z.string().uuid(),
});

export const POST = dashboardRoute({
  // Viewer role is read-only within the dashboard surface. The
  // playground can perform arbitrary POST/PATCH/DELETE calls against
  // `/api/v1/*`, so giving a viewer access here would silently grant
  // write capability they're explicitly denied elsewhere. `member`
  // is the lowest role allowed to mutate firm state.
  permission: 'playground.execute',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const input = await parseBody(ctx.request, PlaygroundBody);

    const executeInput = {
      method: input.method,
      path: input.path,
      ...(input.headers !== undefined
        ? { headers: input.headers as Readonly<Record<string, string>> }
        : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    } as const;

    const result = await handlePlaygroundExecute(
      {
        findApiKeyForPlayground,
        resolveBaseUrl: (req) => {
          const url = new URL(req.url);
          return url.origin;
        },
      },
      ctx,
      executeInput,
      input.apiKeyId,
    );

    // Playground traffic is cheap to fabricate and each call can
    // mutate production-adjacent state (test-mode KYC sessions,
    // webhook fires). Log every attempt, successful or not, so the
    // firm's audit trail can answer "who poked the API from the
    // dashboard and when". Failure to write audit must NOT break the
    // user-facing response: swallow + warn.
    try {
      await writeAudit(ctx.db, {
        action: 'api_key.playground_used',
        actor: firmUserActor({
          id: ctx.user.id,
          firmId: ctx.firm.id,
          label: ctx.user.email,
        }),
        target: uuidTarget({ kind: 'api_key', id: input.apiKeyId }),
        context: buildAuditRequestContext({
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          requestId: ctx.requestId,
        }),
        meta: {
          method: input.method,
          path: input.path,
          status: result.status,
          latencyMs: result.latencyMs,
        },
        ts: ctx.now,
      });
    } catch {
      // Intentional no-op, the audit writer already logs internally,
      // and a playground proxy that refuses to return because an
      // unrelated subsystem went down is a worse failure mode than a
      // temporarily silent audit trail.
    }

    return ctx.json(result);
  },
});
