/**
 * Internal webhook delivery inspection routes.
 *
 * The public surface (`/api/v1/webhooks/...`) is used by firms to manage
 * their subscriptions via API key. The internal surface here is used by
 * the dashboard UI to inspect delivery history across all subscriptions
 * and to manually replay a failed delivery. Replay is idempotent: the
 * original delivery row is reused, the attempt counter is incremented,
 * and the worker picks it up on the next sweep.
 */

import { PaginationQuery, SecurityRequirements, paginated } from '../../common';
import { OpenApiTags, registry, z } from '../../registry';
import { WebhookDeliveryStatus } from '../../schemas/enums';
import { WebhookDeliveryId } from '../../schemas/identifiers';
import { WebhookDeliverySummary } from '../../schemas/webhook';
import { internalResponses } from '../helpers';

const DeliveriesQuery = PaginationQuery.extend({
  subscriptionId: z
    .uuid()
    .optional()
    .openapi({
      param: { name: 'subscriptionId', in: 'query' },
      description: 'Filter by webhook subscription id.',
    }),
  status: WebhookDeliveryStatus.optional().openapi({
    param: { name: 'status', in: 'query' },
    description: 'Filter by delivery status.',
  }),
}).openapi('InternalDeliveriesQuery', {
  description: 'Query parameters for `GET /api/internal/webhooks/deliveries`.',
});

const DeliveryIdParam = z.object({
  id: WebhookDeliveryId.openapi({ param: { name: 'id', in: 'path' } }),
});

registry.registerPath({
  method: 'get',
  path: '/api/internal/webhooks/deliveries',
  summary: 'List webhook deliveries across all firm subscriptions',
  description:
    'Returns webhook delivery attempts across every subscription owned by the firm, newest first. The dashboard uses this surface for the unified delivery log view. Cursor paginated.',
  tags: [OpenApiTags.InternalWebhooks],
  security: SecurityRequirements.sessionCookie(),
  request: {
    query: DeliveriesQuery,
  },
  responses: internalResponses({
    status: 200,
    description: 'Paginated delivery attempts.',
    schema: paginated(WebhookDeliverySummary),
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/webhooks/deliveries/{id}/replay',
  summary: 'Replay a webhook delivery',
  description:
    'Requeues a previously-attempted delivery for another send. Safe to call on any delivery in a terminal state (`succeeded`, `failed`, `dead`); the worker will deduplicate at the HTTP level via the envelope `id`. Requires the `admin` or `owner` firm-user role.',
  tags: [OpenApiTags.InternalWebhooks],
  security: SecurityRequirements.sessionCookie(),
  request: {
    params: DeliveryIdParam,
  },
  responses: internalResponses({
    status: 202,
    description: 'Delivery re-enqueued.',
    schema: WebhookDeliverySummary,
  }),
});
