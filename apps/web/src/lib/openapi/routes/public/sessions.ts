/**
 * Public KYC session routes.
 *
 * A session represents an end user going through Didit identity capture
 * (phase 1: ID + liveness + face match) and optionally the address
 * verification flow (phase 2: proof of address) before a credential is
 * minted on Sepolia MainNet.
 */

import { PaginationQuery, SecurityRequirements, paginated } from '../../common';
import { OpenApiTags, registry, z } from '../../registry';
import { KycSessionId } from '../../schemas/identifiers';
import {
  SessionCreateRequest,
  SessionDetail,
  SessionListQuery,
  SessionSummary,
} from '../../schemas/session';
import { publicNoContentResponses, publicResponses } from '../helpers';

registry.registerPath({
  method: 'post',
  path: '/api/v1/sessions',
  summary: 'Create a KYC session',
  description:
    'Starts a new verification session. Returns the Didit redirect URLs the end user must visit. The firm key must hold the `kyc:create` scope.',
  tags: [OpenApiTags.Sessions],
  security: SecurityRequirements.apiKey(),
  request: {
    body: {
      description: 'Session parameters.',
      required: true,
      content: {
        'application/json': { schema: SessionCreateRequest },
      },
    },
  },
  responses: publicResponses({
    status: 201,
    description: 'Session created. The `redirectUrl` in the response points at Didit phase 1.',
    schema: SessionDetail,
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions/{id}',
  summary: 'Read a KYC session',
  description:
    'Returns the full session state including both Didit phases. Safe to poll; rate limit is the firm standard (60 req/s default).',
  tags: [OpenApiTags.Sessions],
  security: SecurityRequirements.apiKey(),
  request: {
    params: z.object({
      id: KycSessionId.openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: publicResponses({
    status: 200,
    description: 'Session detail.',
    schema: SessionDetail,
  }),
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/sessions/{id}',
  summary: 'Cancel a KYC session',
  description:
    'Marks a session as `expired` server-side. Has no effect if the session is already in a terminal state (`approved`, `rejected`, `expired`, `revoked`).',
  tags: [OpenApiTags.Sessions],
  security: SecurityRequirements.apiKey(),
  request: {
    params: z.object({
      id: KycSessionId.openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: publicNoContentResponses('Session canceled.'),
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions',
  summary: 'List KYC sessions',
  description: 'Cursor-paginated list of sessions, newest first.',
  tags: [OpenApiTags.Sessions],
  security: SecurityRequirements.apiKey(),
  request: {
    query: PaginationQuery.extend(SessionListQuery.shape),
  },
  responses: publicResponses({
    status: 200,
    description: 'Paginated list of sessions.',
    schema: paginated(SessionSummary),
  }),
});
