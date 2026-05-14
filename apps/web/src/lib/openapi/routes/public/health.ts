/**
 * Public, unauthenticated health and status routes.
 *
 * These are the only API surfaces that do NOT require an API key and
 * do NOT carry rate-limit headers. Monitoring probes and uptime
 * checkers can hit them freely.
 */

import { SecurityRequirements } from '../../common';
import { OpenApiTags, registry } from '../../registry';
import { HealthResponse, StatusResponse } from '../../schemas/health';
import { healthResponses } from '../helpers';

registry.registerPath({
  method: 'get',
  path: '/api/v1/health',
  summary: 'Liveness probe',
  description:
    'Aggregated liveness of the API. Returns 200 when every critical check passes, 503 (`maintenance`) otherwise. Safe to hit from unauthenticated monitoring tools.',
  tags: [OpenApiTags.Health],
  security: SecurityRequirements.none(),
  responses: healthResponses({
    status: 200,
    description: 'All checks green.',
    schema: HealthResponse,
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/status',
  summary: 'Component status',
  description:
    'Public component status view — identical data shown on the `/status` page. Returns 200 regardless of the underlying component states; the states themselves describe the outcome.',
  tags: [OpenApiTags.Health],
  security: SecurityRequirements.none(),
  responses: healthResponses({
    status: 200,
    description: 'Public status snapshot.',
    schema: StatusResponse,
  }),
});
