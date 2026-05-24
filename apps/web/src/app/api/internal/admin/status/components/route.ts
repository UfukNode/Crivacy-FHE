/**
 * GET  /api/internal/admin/status/components, list status components
 * POST /api/internal/admin/status/components, create a status component
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { handleCreateComponent, handleListComponents } from '@/server/handlers';
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

const CreateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional(),
  groupName: z.string().max(64).optional(),
  position: z.number().int().min(0).optional(),
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

export const GET = adminRoute({
  // Read is gated with the same permission as manage, status page is
  // Admin+ territory; Support doesn't see the management UI.
  permission: 'admin.status.component_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const components = await handleListComponents(getDeps(), ctx);
    return ctx.json({ components });
  },
});

export const POST = adminRoute({
  permission: 'admin.status.component_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const input = await parseBody(ctx.request, CreateBody);
    const result = await handleCreateComponent(getDeps(), ctx, input);
    return ctx.json(result, 201);
  },
});
