/**
 * GET /api/internal/admin/system/metrics, internal system stats
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleGetSystemMetrics } from '@/server/handlers';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
  getSystemMetrics,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  permission: 'admin.system.metrics_read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const metrics = await handleGetSystemMetrics({ getMetrics: getSystemMetrics }, ctx);
    return ctx.json(metrics);
  },
});
