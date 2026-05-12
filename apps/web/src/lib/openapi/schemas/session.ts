/**
 * KYC session schemas.
 *
 * A "session" in API terms is the end-to-end verification attempt: the
 * user is sent to Didit's SDK, captures ID + liveness, optionally
 * captures proof of address, and the final decision lands here. The
 * credential is minted only once a session transitions to
 * `approved`.
 */

import { DateTimeIso, HttpsUrl, UserRef } from '../common/primitives';
import { z } from '../registry';
import { KycLevel, KycStatus } from './enums';
import { FirmId, KycSessionId } from './identifiers';

/**
 * Opaque metadata bag firms can stamp onto a session. Kept strict on the
 * top-level shape (string keys, any JSON-safe value) but deliberately
 * unbounded — firms use this to thread their own correlation ids. 4 KB
 * hard limit on the serialized payload is enforced at the route layer.
 */
export const SessionMetadata = z
  .record(z.string().min(1).max(64), z.unknown())
  .openapi('SessionMetadata', {
    description:
      'Free-form JSON metadata the firm attaches to a session. Keys ≤ 64 characters; entire payload ≤ 4 KiB.',
    example: { orderId: 'ord_42', customerTier: 'gold' },
  });
export type SessionMetadata = z.infer<typeof SessionMetadata>;

export const SessionCreateRequest = z
  .object({
    userRef: UserRef,
    level: KycLevel.default('basic'),
    redirectUrl: HttpsUrl.optional().openapi({
      description:
        'URL the Didit flow returns the user to on completion. If omitted, the firm-default from `/api/internal/firm` is used.',
    }),
    language: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, { message: 'Must be BCP-47 (e.g. `en`, `en-US`, `tr`).' })
      .optional()
      .openapi({ example: 'en' }),
    metadata: SessionMetadata.optional(),
  })
  .openapi('SessionCreateRequest', {
    description: 'Payload for `POST /api/v1/sessions`.',
  });
export type SessionCreateRequest = z.infer<typeof SessionCreateRequest>;

export const SessionSummary = z
  .object({
    id: KycSessionId,
    firmId: FirmId,
    userRef: UserRef,
    status: KycStatus,
    level: KycLevel,
    createdAt: DateTimeIso,
    completedAt: DateTimeIso.nullable(),
  })
  .openapi('SessionSummary', {
    description:
      'Compact session view returned by list endpoints. Structurally identical to `KycSessionSummary` in `@crivacy/shared-types`.',
  });
export type SessionSummary = z.infer<typeof SessionSummary>;

export const SessionPhase = z
  .object({
    phase: z.enum(['identity', 'address']).openapi({
      description:
        'Verification phase. `identity` runs first (ID + liveness + face match); `address` runs only for the `enhanced` level after identity is approved.',
    }),
    diditSessionId: z.string().min(1).max(128).openapi({
      description: 'Didit session identifier backing this phase.',
    }),
    url: HttpsUrl.openapi({
      description: 'Client-side SDK entry URL for this phase.',
    }),
    status: z
      .enum([
        'pending',
        'in_progress',
        'in_review',
        'resubmission_required',
        'approved',
        'rejected',
        'expired',
      ])
      .openapi({
        description:
          'Phase-local status. `in_review` = compliance is reviewing the submission (manual gate, 24-48h SLA). `resubmission_required` = the user must redo specific flagged steps. `expired` covers both timed-out sessions and previously-approved sessions whose credential expiration policy was triggered (firms should drop any cached verified state and re-verify the user).',
      }),
    startedAt: DateTimeIso.nullable(),
    completedAt: DateTimeIso.nullable(),
  })
  .openapi('SessionPhase', {
    description: 'One phase of a two-step session (identity → address).',
  });
export type SessionPhase = z.infer<typeof SessionPhase>;

export const SessionDetail = SessionSummary.extend({
  redirectUrl: HttpsUrl.nullable(),
  metadata: SessionMetadata.nullable(),
  expiresAt: DateTimeIso,
  phases: z.array(SessionPhase),
}).openapi('SessionDetail', {
  description:
    'Full session view returned by `GET /api/v1/sessions/:id`, including the two-phase Didit breakdown.',
});
export type SessionDetail = z.infer<typeof SessionDetail>;

export const SessionListQuery = z
  .object({
    status: KycStatus.optional().openapi({
      description: 'Filter by lifecycle state.',
      param: { name: 'status', in: 'query' },
    }),
    userRef: UserRef.optional().openapi({
      description: 'Exact match on `userRef`.',
      param: { name: 'userRef', in: 'query' },
    }),
    createdAfter: DateTimeIso.optional().openapi({
      param: { name: 'createdAfter', in: 'query' },
    }),
    createdBefore: DateTimeIso.optional().openapi({
      param: { name: 'createdBefore', in: 'query' },
    }),
  })
  .openapi('SessionListQuery', {
    description: 'Optional filters on `GET /api/v1/sessions`.',
  });
export type SessionListQuery = z.infer<typeof SessionListQuery>;
