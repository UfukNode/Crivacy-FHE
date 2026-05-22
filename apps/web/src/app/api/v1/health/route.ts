/**
 * GET /api/v1/health, liveness probe with dependency checks.
 *
 * Public (unauthenticated) endpoint. Returns 200 when all critical checks
 * pass, 503 when any check fails.
 */

import { handleHealthCheck } from '@/server/handlers';
import { publicRoute } from '@/server/middleware/public-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = publicRoute((ctx) => handleHealthCheck(ctx));
