/**
 * Internal API key management routes.
 *
 * Plaintext keys are revealed exactly once — on creation and on rotation.
 * Every other endpoint returns the masked prefix only. Listing is cursor
 * paginated like every other list surface so the dashboard and any future
 * CLI share a single pattern.
 */

import { PaginationQuery, SecurityRequirements, paginated } from '../../common';
import { OpenApiTags, registry, z } from '../../registry';
import {
  ApiKeyCreateRequest,
  ApiKeySummary,
  ApiKeyWithSecretResponse,
} from '../../schemas/api-key';
import { ApiKeyId } from '../../schemas/identifiers';
import { internalNoContentResponses, internalResponses } from '../helpers';

const ApiKeyIdParam = z.object({
  id: ApiKeyId.openapi({ param: { name: 'id', in: 'path' } }),
});

registry.registerPath({
  method: 'get',
  path: '/api/internal/api-keys',
  summary: 'List API keys',
  description:
    'Returns every API key issued to the firm, regardless of mode or revocation state. Cursor paginated.',
  tags: [OpenApiTags.InternalApiKeys],
  security: SecurityRequirements.sessionCookie(),
  request: {
    query: PaginationQuery,
  },
  responses: internalResponses({
    status: 200,
    description: 'Paginated list of API keys (prefixes only).',
    schema: paginated(ApiKeySummary),
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/api-keys',
  summary: 'Create an API key',
  description:
    'Mints a new API key and returns the full plaintext secret **exactly once**. Store the secret immediately — every subsequent response masks it. Requires the `admin` or `owner` firm-user role.',
  tags: [OpenApiTags.InternalApiKeys],
  security: SecurityRequirements.sessionCookie(),
  request: {
    body: {
      description: 'API key parameters.',
      required: true,
      content: {
        'application/json': { schema: ApiKeyCreateRequest },
      },
    },
  },
  responses: internalResponses({
    status: 201,
    description: 'Key created. Contains the plaintext.',
    schema: ApiKeyWithSecretResponse,
  }),
});

registry.registerPath({
  method: 'delete',
  path: '/api/internal/api-keys/{id}',
  summary: 'Revoke an API key',
  description:
    'Marks the key as revoked. Subsequent requests signed with the key will fail with 401. Revocation is irreversible; use `POST /api/internal/api-keys/{id}/rotate` when a rolling replacement is desired instead.',
  tags: [OpenApiTags.InternalApiKeys],
  security: SecurityRequirements.sessionCookie(),
  request: {
    params: ApiKeyIdParam,
  },
  responses: internalNoContentResponses('Key revoked.'),
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/api-keys/{id}/rotate',
  summary: 'Rotate an API key',
  description:
    'Issues a new plaintext secret for the same key record, revoking the previous plaintext. The key id, prefix display name, scopes, and mode are unchanged. The new plaintext is returned **exactly once**.',
  tags: [OpenApiTags.InternalApiKeys],
  security: SecurityRequirements.sessionCookie(),
  request: {
    params: ApiKeyIdParam,
  },
  responses: internalResponses({
    status: 200,
    description: 'Key rotated. Contains the new plaintext.',
    schema: ApiKeyWithSecretResponse,
  }),
});
