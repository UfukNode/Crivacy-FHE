/**
 * PATCH /api/internal/admin/status/incidents/:id, update incident
 * POST  /api/internal/admin/status/incidents/:id, add timeline update
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { handleAddTimelineUpdate, handleUpdateIncident } from '@/server/handlers';
import { adminRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  addIncidentTimelineUpdate,
  createStatusComponent,
  createStatusIncident,
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
  listStatusComponentsForAdmin,
  listStatusIncidentsForAdmin,
  updateStatusComponentForAdmin,
  updateStatusIncident,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UpdateBody = z.object({
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
  body: z.string().max(4096).optional(),
  published: z.boolean().optional(),
});

const TimelineBody = z.object({
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
  body: z.string().min(1).max(4096),
});

function getDeps() {
  return {
    listComponents: listStatusComponentsForAdmin,
    createComponent: createStatusComponent,
    updateComponent: updateStatusComponentForAdmin,
    listIncidents: listStatusIncidentsForAdmin,
    createIncident: createStatusIncident,
    updateIncident: updateStatusIncident,
    addTimelineUpdate: addIncidentTimelineUpdate,
  };
}

export const PATCH = adminRoute({
  permission: 'admin.status.incident_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const input = await parseBody(ctx.request, UpdateBody);

    // Auto-set timestamps based on status transitions
    const updates: Record<string, unknown> = { ...input };
    if (input.status === 'resolved') {
      updates['resolvedAt'] = ctx.now;
    }
    if (input.status === 'identified') {
      updates['identifiedAt'] = ctx.now;
    }
    if (input.status === 'monitoring') {
      updates['monitoringAt'] = ctx.now;
    }

    const result = await handleUpdateIncident(
      getDeps(),
      ctx,
      id,
      updates as Parameters<typeof handleUpdateIncident>[3],
    );
    if (result === null) {
      return ctx.errorJson('not_found', 'Incident not found.', 404);
    }
    return ctx.json(result);
  },
});

export const POST = adminRoute({
  permission: 'admin.status.incident_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const input = await parseBody(ctx.request, TimelineBody);
    await handleAddTimelineUpdate(getDeps(), ctx, id, input);
    return ctx.json({ success: true }, 201);
  },
});
