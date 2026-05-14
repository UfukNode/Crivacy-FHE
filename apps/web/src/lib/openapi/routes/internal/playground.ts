/**
 * Internal playground route.
 *
 * `POST /api/internal/playground/execute` is the only supported entry
 * point. The browser never sees any API key; the dashboard submits the
 * test-mode api key id plus the request shape and the server performs
 * the actual HTTP call on behalf of the dashboard user, then echoes back
 * the response. Test-mode keys only — live-mode ids are rejected by the
 * service layer.
 */

import { SecurityRequirements } from '../../common';
import { OpenApiTags, registry } from '../../registry';
import { PlaygroundExecuteRequest, PlaygroundExecuteResponse } from '../../schemas/playground';
import { internalResponses } from '../helpers';

registry.registerPath({
  method: 'post',
  path: '/api/internal/playground/execute',
  summary: 'Proxy a request through a test-mode API key',
  description:
    'Executes a public API request on behalf of the dashboard user using one of their **test-mode** API keys. The request and response are recorded in a dedicated playground log separate from the production usage table so playground traffic never contaminates billing or charts. Live-mode keys are rejected with 400 (`invalid_argument`).',
  tags: [OpenApiTags.InternalPlayground],
  security: SecurityRequirements.sessionCookie(),
  request: {
    body: {
      description: 'Playground request envelope.',
      required: true,
      content: {
        'application/json': { schema: PlaygroundExecuteRequest },
      },
    },
  },
  responses: internalResponses({
    status: 200,
    description: 'Response echoing the backing public-API call result.',
    schema: PlaygroundExecuteResponse,
  }),
});
