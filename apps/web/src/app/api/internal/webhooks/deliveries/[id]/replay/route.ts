/**
 * POST /api/internal/webhooks/deliveries/:id/replay, replay a failed delivery
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { handleReplayDelivery } from '@/server/handlers';
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

const ParamSchema = z.object({
  id: z.string().uuid(),
});

export const POST = dashboardRoute({
  // Matrix: Member+ can replay deliveries (observability helper, not
  // a destructive op). Legacy `minRole: 'admin'` loosened to 'member'
  // to match the granular permission.
  permission: 'webhook.delivery.replay',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const segments = url.pathname.split('/');
    // pathname = /api/internal/webhooks/deliveries/{id}/replay
    const rawId = segments[segments.length - 2] ?? '';
    const params = ParamSchema.parse({ id: rawId });

    const result = await handleReplayDelivery(
      { listDeliveries: listDashboardDeliveries, replayDelivery },
      ctx,
      params.id,
    );
    if (result === null) {
      return ctx.errorJson('not_found', `Delivery "${params.id}" not found.`, 404);
    }
    return ctx.json(result, 202);
  },
});
