/**
 * GET /api/internal/audit-log, firm audit log viewer
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleListAuditEntries } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
  listAuditEntries,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = dashboardRoute({
  permission: 'audit.read.firm',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const action = url.searchParams.get('action');
    const limitStr = url.searchParams.get('limit');
    const cursor = url.searchParams.get('cursor');

    const result = await handleListAuditEntries({ listAuditEntries }, ctx, {
      ...(action !== null ? { action } : {}),
      ...(limitStr !== null ? { limit: Number(limitStr) } : {}),
      ...(cursor !== null ? { cursor } : {}),
    });
    return ctx.json(result);
  },
});
