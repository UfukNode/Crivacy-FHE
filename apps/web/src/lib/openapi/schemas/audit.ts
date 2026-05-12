/**
 * Audit log entry schema for the read-only internal endpoint.
 */

import { DateTimeIso } from '../common/primitives';
import { z } from '../registry';
import { AuditActorKind, AuditTargetKind } from './enums';
import { AuditLogEntryId, FirmId } from './identifiers';

export const AuditLogEntry = z
  .object({
    id: AuditLogEntryId,
    actorKind: AuditActorKind,
    actorId: z.uuid().nullable(),
    actorLabel: z.string().max(320).nullable(),
    firmId: FirmId.nullable(),
    action: z.string().min(1).max(128).openapi({
      description:
        'Dotted action identifier. Examples: `api_key.created`, `webhook.disabled`, `session.canceled`.',
      example: 'api_key.created',
    }),
    targetKind: AuditTargetKind.nullable(),
    targetId: z.uuid().nullable(),
    targetRef: z.string().max(256).nullable(),
    ip: z.string().max(64).nullable(),
    userAgent: z.string().max(512).nullable(),
    requestId: z.uuid().nullable(),
    meta: z.record(z.string(), z.unknown()),
    ts: DateTimeIso,
  })
  .openapi('AuditLogEntry', {
    description: 'Single audit-log row returned by `GET /api/internal/audit-log`.',
  });
export type AuditLogEntry = z.infer<typeof AuditLogEntry>;

export const AuditLogQuery = z
  .object({
    action: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .openapi({
        param: { name: 'action', in: 'query' },
      }),
    actorKind: AuditActorKind.optional().openapi({
      param: { name: 'actorKind', in: 'query' },
    }),
    targetKind: AuditTargetKind.optional().openapi({
      param: { name: 'targetKind', in: 'query' },
    }),
    since: DateTimeIso.optional().openapi({
      param: { name: 'since', in: 'query' },
    }),
    until: DateTimeIso.optional().openapi({
      param: { name: 'until', in: 'query' },
    }),
  })
  .openapi('AuditLogQuery', {
    description: 'Optional filters for `GET /api/internal/audit-log`.',
  });
export type AuditLogQuery = z.infer<typeof AuditLogQuery>;
