/**
 * Internal audit-log read-only route. The audit table is append-only —
 * there is no admin write surface here. Writes happen transparently from
 * service code when a mutation happens; this endpoint exposes a filtered,
 * paginated read view for compliance inspection.
 */

import { PaginationQuery, SecurityRequirements, paginated } from '../../common';
import { OpenApiTags, registry } from '../../registry';
import { AuditLogEntry, AuditLogQuery } from '../../schemas/audit';
import { internalResponses } from '../helpers';

registry.registerPath({
  method: 'get',
  path: '/api/internal/audit-log',
  summary: 'Read the firm audit log',
  description:
    'Returns audit-log rows scoped to the authenticated firm, filtered by the query parameters, newest first. Rows are never edited or deleted; retention is controlled by the firm `dataRetentionDays` setting. Requires the `admin` or `owner` firm-user role.',
  tags: [OpenApiTags.InternalAudit],
  security: SecurityRequirements.sessionCookie(),
  request: {
    query: PaginationQuery.extend(AuditLogQuery.shape),
  },
  responses: internalResponses({
    status: 200,
    description: 'Paginated audit log entries.',
    schema: paginated(AuditLogEntry),
  }),
});
