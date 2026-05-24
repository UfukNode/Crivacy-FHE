/**
 * GET /api/internal/webhooks/deliveries, list webhook deliveries
 */

import { getAuthConfig } from '@/lib/auth/config';
import { handleListDashboardDeliveries } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
  listDashboardDeliveries,
  replayDelivery,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = dashboardRoute({
  permission: 'webhook.delivery.read',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const endpointId = url.searchParams.get('endpointId');
    const status = url.searchParams.get('status');
    const limitStr = url.searchParams.get('limit');
    const cursor = url.searchParams.get('cursor');

    const result = await handleListDashboardDeliveries(
      { listDeliveries: listDashboardDeliveries, replayDelivery },
      ctx,
      {
        ...(endpointId !== null ? { endpointId } : {}),
        ...(status !== null ? { status } : {}),
        ...(limitStr !== null ? { limit: Number(limitStr) } : {}),
        ...(cursor !== null ? { cursor } : {}),
      },
    );
    return ctx.json(result);
  },
});
