/**
 * Internal usage charts route — the dashboard-only aggregate view that
 * backs the main usage chart. Public `GET /api/v1/usage` returns the
 * monthly rollup; this endpoint returns dense hourly samples (at most
 * 744 points = 31 days) so the dashboard can render stacked bar charts
 * without calling a third-party analytics backend.
 */

import { SecurityRequirements } from '../../common';
import { DateTimeIso } from '../../common/primitives';
import { OpenApiTags, registry, z } from '../../registry';
import { UsageChartsResponse } from '../../schemas/usage';
import { internalResponses } from '../helpers';

const UsageChartsQuery = z
  .object({
    from: DateTimeIso.openapi({
      param: { name: 'from', in: 'query' },
      description:
        'Inclusive start of the chart window. Must be within the last 31 days; earlier dates are clamped.',
    }),
    to: DateTimeIso.openapi({
      param: { name: 'to', in: 'query' },
      description:
        'Exclusive end of the chart window. Must be greater than `from` and must not be in the future.',
    }),
  })
  .openapi('UsageChartsQuery', {
    description: 'Query parameters for `GET /api/internal/usage/charts`.',
  });

registry.registerPath({
  method: 'get',
  path: '/api/internal/usage/charts',
  summary: 'Hourly usage samples for dashboard charts',
  description:
    'Returns dense hourly usage samples for the requested window. The endpoint is read-only and caches internally for 60 seconds, so multiple dashboard tabs rendering the same window share the same response body.',
  tags: [OpenApiTags.InternalUsage],
  security: SecurityRequirements.sessionCookie(),
  request: {
    query: UsageChartsQuery,
  },
  responses: internalResponses({
    status: 200,
    description: 'Hourly usage chart data.',
    schema: UsageChartsResponse,
  }),
});
