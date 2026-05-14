/**
 * Admin-only internal system inspection routes.
 *
 * These endpoints expose internal counters that are normally only
 * reachable by Prometheus scraping the app. They are intentionally NOT
 * exposed via any public or firm-scoped route — leaking db pool size or
 * queue depths to tenants would be an information disclosure bug.
 */

import { SecurityRequirements } from '../../common';
import { OpenApiTags, registry } from '../../registry';
import { AdminQueuesResponse, AdminSystemMetricsResponse } from '../../schemas/admin-system';
import { adminResponses } from '../helpers';

registry.registerPath({
  method: 'get',
  path: '/api/admin/system/metrics',
  summary: 'Live system metrics',
  description:
    'Returns live internal metrics — db pool state, chain reachability, didit reachability, recent HTTP error rate. Not cached; every call hits the in-process metric registry.',
  tags: [OpenApiTags.AdminSystem],
  security: SecurityRequirements.adminSessionCookie(),
  responses: adminResponses({
    status: 200,
    description: 'Live metrics snapshot.',
    schema: AdminSystemMetricsResponse,
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/system/queues',
  summary: 'pg-boss queue depth',
  description:
    'Returns the pending/active/completed/failed count for every background queue, plus the oldest pending job timestamp. Used by the admin dashboard to detect stuck workers.',
  tags: [OpenApiTags.AdminSystem],
  security: SecurityRequirements.adminSessionCookie(),
  responses: adminResponses({
    status: 200,
    description: 'Queue state snapshot.',
    schema: AdminQueuesResponse,
  }),
});
