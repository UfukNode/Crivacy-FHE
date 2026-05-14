/**
 * Admin-only firm management routes.
 *
 * These are Crivacy-operator-only endpoints, gated behind the admin
 * session cookie (`__Host-crv_admin_session`) and the `admin` role claim.
 * Firm creation provisions a new firm record, an initial owner user, and
 * returns a one-shot password-reset URL for handoff.
 */

import { PaginationQuery, SecurityRequirements, paginated } from '../../common';
import { OpenApiTags, registry, z } from '../../registry';
import {
  AdminFirmCreateRequest,
  AdminFirmCreatedResponse,
  AdminFirmSummary,
  AdminFirmUpdateRequest,
} from '../../schemas/admin-firm';
import { FirmId } from '../../schemas/identifiers';
import { adminNoContentResponses, adminResponses } from '../helpers';

const FirmIdParam = z.object({
  id: FirmId.openapi({ param: { name: 'id', in: 'path' } }),
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/firms',
  summary: 'List firms',
  description:
    'Returns every firm in the system, including soft-deleted records. Cursor paginated. Sort order is `createdAt DESC`.',
  tags: [OpenApiTags.AdminFirms],
  security: SecurityRequirements.adminSessionCookie(),
  request: {
    query: PaginationQuery,
  },
  responses: adminResponses({
    status: 200,
    description: 'Paginated list of firms.',
    schema: paginated(AdminFirmSummary),
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/firms',
  summary: 'Create a firm',
  description:
    'Provisions a new firm record and its initial owner user. The response carries a one-shot password-reset URL valid for 24 hours — hand it to the firm operator out-of-band. No plaintext password is ever generated or stored.',
  tags: [OpenApiTags.AdminFirms],
  security: SecurityRequirements.adminSessionCookie(),
  request: {
    body: {
      description: 'New firm parameters.',
      required: true,
      content: {
        'application/json': { schema: AdminFirmCreateRequest },
      },
    },
  },
  responses: adminResponses({
    status: 201,
    description: 'Firm created.',
    schema: AdminFirmCreatedResponse,
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/firms/{id}',
  summary: 'Read a firm',
  description: 'Returns the admin view of a firm, including limit overrides and soft-delete state.',
  tags: [OpenApiTags.AdminFirms],
  security: SecurityRequirements.adminSessionCookie(),
  request: {
    params: FirmIdParam,
  },
  responses: adminResponses({
    status: 200,
    description: 'Firm detail.',
    schema: AdminFirmSummary,
  }),
});

registry.registerPath({
  method: 'patch',
  path: '/api/admin/firms/{id}',
  summary: 'Update a firm',
  description:
    'Partially updates a firm — tier, per-firm rate-limit override, per-firm monthly quota override, data retention window. Any field not present in the request body is left untouched. Tier changes take effect immediately for subsequent requests.',
  tags: [OpenApiTags.AdminFirms],
  security: SecurityRequirements.adminSessionCookie(),
  request: {
    params: FirmIdParam,
    body: {
      description: 'Partial firm update.',
      required: true,
      content: {
        'application/json': { schema: AdminFirmUpdateRequest },
      },
    },
  },
  responses: adminResponses({
    status: 200,
    description: 'Updated firm.',
    schema: AdminFirmSummary,
  }),
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/firms/{id}',
  summary: 'Soft-delete a firm',
  description:
    'Marks the firm as soft-deleted. All firm users are immediately logged out, every API key is revoked, and outbound webhooks are disabled. The firm record is retained for audit and billing; hard deletion happens through a separate retention job, not this endpoint.',
  tags: [OpenApiTags.AdminFirms],
  security: SecurityRequirements.adminSessionCookie(),
  request: {
    params: FirmIdParam,
  },
  responses: adminNoContentResponses('Firm soft-deleted.'),
});
