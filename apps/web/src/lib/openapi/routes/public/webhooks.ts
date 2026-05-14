/**
 * Public webhook subscription management routes.
 */

import { PaginationQuery, SecurityRequirements, paginated } from '../../common';
import { OpenApiTags, registry, z } from '../../registry';
import { WebhookSubscriptionId } from '../../schemas/identifiers';
import {
  WebhookCreateRequest,
  WebhookDeliverySummary,
  WebhookSubscriptionCreatedResponse,
  WebhookSubscriptionSummary,
  WebhookTestRequest,
  WebhookUpdateRequest,
} from '../../schemas/webhook';
import { publicNoContentResponses, publicResponses } from '../helpers';

const SubscriptionIdParam = z.object({
  id: WebhookSubscriptionId.openapi({ param: { name: 'id', in: 'path' } }),
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/webhooks',
  summary: 'List webhook subscriptions',
  description:
    'Returns every webhook subscription owned by the firm. Requires `webhooks:manage` scope.',
  tags: [OpenApiTags.Webhooks],
  security: SecurityRequirements.apiKey(),
  request: {
    query: PaginationQuery,
  },
  responses: publicResponses({
    status: 200,
    description: 'Paginated list of subscriptions.',
    schema: paginated(WebhookSubscriptionSummary),
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/webhooks',
  summary: 'Create a webhook subscription',
  description:
    'Creates a new webhook subscription and returns the full signing secret **exactly once**. Store the secret immediately — every subsequent response masks it. Requires `webhooks:manage` scope.',
  tags: [OpenApiTags.Webhooks],
  security: SecurityRequirements.apiKey(),
  request: {
    body: {
      description: 'Subscription parameters.',
      required: true,
      content: {
        'application/json': { schema: WebhookCreateRequest },
      },
    },
  },
  responses: publicResponses({
    status: 201,
    description: 'Subscription created. Contains the full signing secret.',
    schema: WebhookSubscriptionCreatedResponse,
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/webhooks/{id}',
  summary: 'Read a webhook subscription',
  tags: [OpenApiTags.Webhooks],
  security: SecurityRequirements.apiKey(),
  request: {
    params: SubscriptionIdParam,
  },
  responses: publicResponses({
    status: 200,
    description: 'Subscription detail (secret masked).',
    schema: WebhookSubscriptionSummary,
  }),
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/webhooks/{id}',
  summary: 'Update a webhook subscription',
  description:
    'Partially updates a subscription. Supports toggling active state, updating the URL, adjusting the event filter, or setting a new description. Requires `webhooks:manage` scope.',
  tags: [OpenApiTags.Webhooks],
  security: SecurityRequirements.apiKey(),
  request: {
    params: SubscriptionIdParam,
    body: {
      description: 'Partial subscription update.',
      required: true,
      content: { 'application/json': { schema: WebhookUpdateRequest } },
    },
  },
  responses: publicResponses({
    status: 200,
    description: 'Updated subscription (secret masked).',
    schema: WebhookSubscriptionSummary,
  }),
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/webhooks/{id}',
  summary: 'Delete a webhook subscription',
  description:
    'Hard-deletes the subscription. Pending deliveries for this subscription are dropped. Requires `webhooks:manage` scope.',
  tags: [OpenApiTags.Webhooks],
  security: SecurityRequirements.apiKey(),
  request: {
    params: SubscriptionIdParam,
  },
  responses: publicNoContentResponses('Subscription deleted.'),
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/webhooks/{id}/test',
  summary: 'Send a test event',
  description:
    'Enqueues a synthetic delivery to the subscription URL. Returns `202 Accepted` with the delivery id so the caller can poll `GET /api/v1/webhooks/{id}/deliveries` for the outcome.',
  tags: [OpenApiTags.Webhooks],
  security: SecurityRequirements.apiKey(),
  request: {
    params: SubscriptionIdParam,
    body: {
      description: 'Test event parameters.',
      required: true,
      content: { 'application/json': { schema: WebhookTestRequest } },
    },
  },
  responses: publicResponses({
    status: 202,
    description: 'Test delivery enqueued.',
    schema: WebhookDeliverySummary,
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/webhooks/{id}/deliveries',
  summary: 'List recent delivery attempts',
  description: 'Returns the most recent delivery attempts for a subscription, newest first.',
  tags: [OpenApiTags.Webhooks],
  security: SecurityRequirements.apiKey(),
  request: {
    params: SubscriptionIdParam,
    query: PaginationQuery,
  },
  responses: publicResponses({
    status: 200,
    description: 'Paginated delivery attempts.',
    schema: paginated(WebhookDeliverySummary),
  }),
});
