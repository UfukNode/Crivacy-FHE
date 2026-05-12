/**
 * Health and public status schemas.
 */

import { DateTimeIso } from '../common/primitives';
import { z } from '../registry';
import { IncidentSeverity, IncidentStatus, StatusComponentState } from './enums';
import { StatusComponentId, StatusIncidentId } from './identifiers';

export const HealthCheck = z
  .object({
    name: z.string().min(1).max(64),
    ok: z.boolean(),
    latencyMs: z.number().int().min(0).nullable(),
    error: z.string().max(512).nullable(),
  })
  .openapi('HealthCheck', {
    description: 'Single backing dependency check (`database`, `chain`, `didit`, `queue`).',
  });
export type HealthCheck = z.infer<typeof HealthCheck>;

export const HealthResponse = z
  .object({
    ok: z.boolean().openapi({
      description: 'Overall aggregated health. `false` if any critical check is down.',
    }),
    version: z.string().min(1).max(64).openapi({
      description: 'Deployed application version (`package.json#version`).',
      example: '1.0.0',
    }),
    gitSha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .openapi({
        description: 'Git SHA of the currently deployed build.',
        example: '1a206c4',
      }),
    uptimeSec: z.number().int().min(0),
    checks: z.array(HealthCheck),
  })
  .openapi('HealthResponse', {
    description: 'Response for `GET /api/v1/health`.',
  });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const StatusComponent = z
  .object({
    id: StatusComponentId,
    slug: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    description: z.string().max(512).nullable(),
    group: z.string().max(64).nullable(),
    state: StatusComponentState,
    updatedAt: DateTimeIso,
  })
  .openapi('StatusComponent', {
    description: 'Single public status page component.',
  });
export type StatusComponent = z.infer<typeof StatusComponent>;

export const StatusIncident = z
  .object({
    id: StatusIncidentId,
    title: z.string().min(1).max(256),
    body: z.string().min(1),
    severity: IncidentSeverity,
    status: IncidentStatus,
    componentIds: z.array(StatusComponentId),
    startedAt: DateTimeIso,
    identifiedAt: DateTimeIso.nullable(),
    monitoringAt: DateTimeIso.nullable(),
    resolvedAt: DateTimeIso.nullable(),
    updates: z
      .array(
        z.object({
          at: DateTimeIso,
          status: IncidentStatus,
          body: z.string().min(1),
        }),
      )
      .openapi({ description: 'Timeline entries, oldest first.' }),
  })
  .openapi('StatusIncident', {
    description: 'Incident record surfaced on the public status page.',
  });
export type StatusIncident = z.infer<typeof StatusIncident>;

export const StatusResponse = z
  .object({
    overall: StatusComponentState.openapi({
      description:
        'Worst state across all public components. Never more optimistic than any child.',
    }),
    components: z.array(StatusComponent),
    activeIncidents: z.array(StatusIncident),
    generatedAt: DateTimeIso,
  })
  .openapi('StatusResponse', {
    description: 'Response for `GET /api/v1/status`.',
  });
export type StatusResponse = z.infer<typeof StatusResponse>;
