/**
 * GET  /api/internal/admin/status/incidents, list incidents
 * POST /api/internal/admin/status/incidents, create incident
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { handleCreateIncident, handleListIncidents } from '@/server/handlers';
import { adminRoute } from '@/server/middleware';
import { parseBody, parseQuery } from '@/server/middleware/parse';
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

const ListQuery = z.object({
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const CreateBody = z.object({
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(4096),
  severity: z.enum(['minor', 'major', 'critical']),
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
  componentIds: z.array(z.string().uuid()).optional(),
  published: z.boolean().optional(),
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
  permission: 'admin.status.incident_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const query = parseQuery(new URL(ctx.request.url), ListQuery);
    const result = await handleListIncidents(getDeps(), ctx, query);
    return ctx.json(result);
  },
});

export const POST = adminRoute({
  permission: 'admin.status.incident_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const input = await parseBody(ctx.request, CreateBody);
    const result = await handleCreateIncident(getDeps(), ctx, input);
    return ctx.json(result, 201);
  },
});
