/**
 * GET /api/internal/admin/audit, global audit log (all firms)
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { handleListGlobalAudit } from '@/server/handlers';
import { adminRoute } from '@/server/middleware';
import { parseQuery } from '@/server/middleware/parse';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
  listGlobalAuditEntries,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AuditQuery = z.object({
  firmId: z.string().uuid().optional(),
  action: z.string().optional(),
  actorKind: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = adminRoute({
  permission: 'admin.audit.read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const query = parseQuery(new URL(ctx.request.url), AuditQuery);
    const result = await handleListGlobalAudit(
      { listGlobalAudit: listGlobalAuditEntries },
      ctx,
      query,
    );
    return ctx.json(result);
  },
});
