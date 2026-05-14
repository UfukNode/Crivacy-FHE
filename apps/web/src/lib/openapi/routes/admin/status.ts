/**
 * Admin-only status-page authoring routes.
 *
 * Components and incidents drive the public `/status` page rendered by
 * the `apps/status` package (PLAN.md step 16). Operators use these two
 * endpoints to publish an incident and to flip a component's state when
 * automated probes fail to detect a partial outage.
 */

import { SecurityRequirements } from '../../common';
import { OpenApiTags, registry } from '../../registry';
import {
  AdminComponentUpdateRequest,
  AdminComponentUpdateResponse,
  AdminIncidentCreateRequest,
  AdminIncidentResponse,
} from '../../schemas/admin-status';
import { adminResponses } from '../helpers';

registry.registerPath({
  method: 'post',
  path: '/api/admin/status/incident',
  summary: 'Publish an incident',
  description:
    'Creates a new status-page incident. When `publish` is true (the default) the incident is immediately visible to unauthenticated callers hitting `GET /api/v1/status`; otherwise the incident is staged as a draft and can be published later via `PATCH`. Linked components are switched to `degraded_performance` or worse depending on the incident severity.',
  tags: [OpenApiTags.AdminStatus],
  security: SecurityRequirements.adminSessionCookie(),
  request: {
    body: {
      description: 'Incident parameters.',
      required: true,
      content: {
        'application/json': { schema: AdminIncidentCreateRequest },
      },
    },
  },
  responses: adminResponses({
    status: 201,
    description: 'Incident created.',
    schema: AdminIncidentResponse,
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/status/component',
  summary: 'Update a component state manually',
  description:
    'Overrides the automated state of a status-page component. When `manualOverride` is true (the default), subsequent probe results will not overwrite the state until the override is cleared by another manual update with `state: operational`. Used to force a component into maintenance during planned work.',
  tags: [OpenApiTags.AdminStatus],
  security: SecurityRequirements.adminSessionCookie(),
  request: {
    body: {
      description: 'Component override parameters.',
      required: true,
      content: {
        'application/json': { schema: AdminComponentUpdateRequest },
      },
    },
  },
  responses: adminResponses({
    status: 200,
    description: 'Component state updated.',
    schema: AdminComponentUpdateResponse,
  }),
});
