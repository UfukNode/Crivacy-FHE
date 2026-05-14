/**
 * Internal firm profile routes — read and partial update. Writes require
 * the `admin` or `owner` firm-user role; the enforcement happens in the
 * service layer (PLAN.md step 10).
 */

import { SecurityRequirements } from '../../common';
import { OpenApiTags, registry } from '../../registry';
import { FirmProfile, FirmUpdateRequest } from '../../schemas/firm';
import { internalResponses } from '../helpers';

registry.registerPath({
  method: 'get',
  path: '/api/internal/firm',
  summary: 'Read firm profile',
  description:
    'Returns the firm profile — branding, contact email, IP allowlist, data retention window. Any dashboard user can read.',
  tags: [OpenApiTags.InternalFirm],
  security: SecurityRequirements.sessionCookie(),
  responses: internalResponses({
    status: 200,
    description: 'Firm profile.',
    schema: FirmProfile,
  }),
});

registry.registerPath({
  method: 'patch',
  path: '/api/internal/firm',
  summary: 'Update firm profile',
  description:
    'Partially updates the firm profile. Each field in the request body is optional; at least one must be present. Requires the `admin` or `owner` firm-user role; the payload is validated against the same schema the public dashboard form uses.',
  tags: [OpenApiTags.InternalFirm],
  security: SecurityRequirements.sessionCookie(),
  request: {
    body: {
      description: 'Partial firm profile update.',
      required: true,
      content: {
        'application/json': { schema: FirmUpdateRequest },
      },
    },
  },
  responses: internalResponses({
    status: 200,
    description: 'Updated firm profile.',
    schema: FirmProfile,
  }),
});
