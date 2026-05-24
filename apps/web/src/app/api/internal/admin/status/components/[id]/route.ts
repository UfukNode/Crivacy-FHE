/**
 * PATCH /api/internal/admin/status/components/:id, update component state
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { handleUpdateComponent } from '@/server/handlers';
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
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(1024).optional(),
  groupName: z.string().max(64).optional(),
  position: z.number().int().min(0).optional(),
  currentState: z
    .enum(['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'])
    .optional(),
  manualOverride: z.boolean().optional(),
  manualOverrideReason: z.string().max(256).optional(),
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
  permission: 'admin.status.component_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const input = await parseBody(ctx.request, UpdateBody);
    const result = await handleUpdateComponent(getDeps(), ctx, id, input);
    if (result === null) {
      return ctx.errorJson('not_found', 'Component not found.', 404);
    }
    return ctx.json(result);
  },
});
