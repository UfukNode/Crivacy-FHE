/**
 * GET /api/v1/status, public component status snapshot.
 *
 * Public (unauthenticated) endpoint. Returns 200 regardless of the
 * underlying component states; the states themselves describe the outcome.
 */

import { handleStatusCheck } from '@/server/handlers';
import type { StatusDeps } from '@/server/handlers';
import { publicRoute } from '@/server/middleware/public-route';
import { listPublicComponents, listPublicIncidents } from '@/server/repositories/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps: StatusDeps = {
  listComponents: listPublicComponents,
  listIncidents: listPublicIncidents,
};

export const GET = publicRoute((ctx) => handleStatusCheck(deps, ctx));
