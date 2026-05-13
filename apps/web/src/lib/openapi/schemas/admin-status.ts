/**
 * Admin-only status page authoring schemas.
 */

import { DateTimeIso, Slug } from '../common/primitives';
import { z } from '../registry';
import { IncidentSeverity, IncidentStatus, StatusComponentState } from './enums';
import { StatusComponentId, StatusIncidentId } from './identifiers';

export const AdminIncidentCreateRequest = z
  .object({
    title: z.string().min(1).max(256),
    body: z.string().min(1).max(10_000),
    severity: IncidentSeverity,
    status: IncidentStatus.default('investigating'),
    componentIds: z.array(StatusComponentId).max(32),
    startedAt: DateTimeIso.optional(),
    publish: z.boolean().default(true),
  })
  .openapi('AdminIncidentCreateRequest', {
    description: 'Payload for `POST /api/admin/status/incident`.',
  });
export type AdminIncidentCreateRequest = z.infer<typeof AdminIncidentCreateRequest>;

export const AdminIncidentResponse = z
  .object({
    id: StatusIncidentId,
    published: z.boolean(),
    startedAt: DateTimeIso,
  })
  .openapi('AdminIncidentResponse', {
    description: 'Response for `POST /api/admin/status/incident`.',
  });
export type AdminIncidentResponse = z.infer<typeof AdminIncidentResponse>;

export const AdminComponentUpdateRequest = z
  .object({
    slug: Slug,
    state: StatusComponentState,
    reason: z.string().min(1).max(512).nullable().optional(),
    manualOverride: z.boolean().default(true),
  })
  .openapi('AdminComponentUpdateRequest', {
    description: 'Payload for `POST /api/admin/status/component`.',
  });
export type AdminComponentUpdateRequest = z.infer<typeof AdminComponentUpdateRequest>;

export const AdminComponentUpdateResponse = z
  .object({
    id: StatusComponentId,
    slug: Slug,
    state: StatusComponentState,
    updatedAt: DateTimeIso,
  })
  .openapi('AdminComponentUpdateResponse', {
    description: 'Response for `POST /api/admin/status/component`.',
  });
export type AdminComponentUpdateResponse = z.infer<typeof AdminComponentUpdateResponse>;
