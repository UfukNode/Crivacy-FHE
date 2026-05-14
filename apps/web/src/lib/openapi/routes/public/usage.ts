/**
 * Public usage + limits routes.
 */

import { SecurityRequirements } from '../../common';
import { OpenApiTags, registry } from '../../registry';
import { LimitsResponse, UsageHistoryResponse, UsageSummary } from '../../schemas/usage';
import { publicResponses } from '../helpers';

registry.registerPath({
  method: 'get',
  path: '/api/v1/usage',
  summary: 'Current period usage',
  description:
    'Returns the aggregate usage for the current calendar month. Requires `usage:read` scope.',
  tags: [OpenApiTags.Usage],
  security: SecurityRequirements.apiKey(),
  responses: publicResponses({
    status: 200,
    description: 'Current month usage aggregate.',
    schema: UsageSummary,
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/usage/history',
  summary: 'Historical usage',
  description:
    'Returns monthly usage aggregates for up to the past 24 months, newest first. Requires `usage:read` scope.',
  tags: [OpenApiTags.Usage],
  security: SecurityRequirements.apiKey(),
  responses: publicResponses({
    status: 200,
    description: 'Historical usage rollup.',
    schema: UsageHistoryResponse,
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/limits',
  summary: 'Rate limit and quota state',
  description:
    'Returns the firm tier, the current token-bucket state, and the remaining monthly quota for the authenticating API key.',
  tags: [OpenApiTags.Limits],
  security: SecurityRequirements.apiKey(),
  responses: publicResponses({
    status: 200,
    description: 'Tier + live rate limit + live quota snapshot.',
    schema: LimitsResponse,
  }),
});
