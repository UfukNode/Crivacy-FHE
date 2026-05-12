/**
 * Webhook schemas — firm-owned outbound subscriptions and the Didit
 * inbound webhook payload.
 *
 * Outbound: firms create a subscription bound to a URL and a set of
 * event types. The delivery worker (PLAN.md step 11) signs every
 * outgoing body with HMAC-SHA256 using a per-subscription secret and
 * retries with exponential backoff until success, the dead-letter
 * threshold is hit, or the subscription is manually disabled.
 *
 * Inbound: Didit posts decisions here. The payload is the shape we get
 * from their `/v3/session/{id}/decision/` webhook, not the API response.
 */

import { DateTimeIso, HttpsUrl, SafeCount } from '../common/primitives';
import { registry, z } from '../registry';
import { WebhookDeliveryStatus, WebhookEventType } from './enums';
import { FirmId, KycSessionId, WebhookDeliveryId, WebhookSubscriptionId } from './identifiers';

/**
 * Subscription record. `secretMasked` is the last four chars of the
 * signing secret — the full secret is only revealed once on creation.
 */
export const WebhookSubscriptionSummary = z
  .object({
    id: WebhookSubscriptionId,
    firmId: FirmId,
    url: HttpsUrl,
    description: z.string().max(256).nullable(),
    events: z.array(WebhookEventType).min(1),
    active: z.boolean(),
    secretMasked: z.string().regex(/^\*{4}[A-Za-z0-9_-]{4}$/, {
      message: 'Must be `****` followed by the last 4 chars of the secret.',
    }),
    createdAt: DateTimeIso,
    updatedAt: DateTimeIso,
    lastDeliveryAt: DateTimeIso.nullable(),
    failureCount: SafeCount,
  })
  .openapi('WebhookSubscriptionSummary', {
    description: 'Summary view of a webhook subscription. Secret is masked.',
  });
export type WebhookSubscriptionSummary = z.infer<typeof WebhookSubscriptionSummary>;

export const WebhookSubscriptionCreatedResponse = WebhookSubscriptionSummary.extend({
  secret: z
    .string()
    .min(32)
    .max(128)
    .regex(/^whsec_[A-Za-z0-9_-]+$/, { message: 'Must be a `whsec_` prefixed secret.' })
    .openapi({
      description:
        'One-shot reveal of the HMAC signing secret. Stored hashed in the database; this is the only response that carries the full value.',
      example: 'whsec_1q2w3e4r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0',
    }),
}).openapi('WebhookSubscriptionCreatedResponse', {
  description:
    'Response for `POST /api/v1/webhooks`. Includes the full signing secret — show it once and store it client-side.',
});
export type WebhookSubscriptionCreatedResponse = z.infer<typeof WebhookSubscriptionCreatedResponse>;

export const WebhookCreateRequest = z
  .object({
    url: HttpsUrl,
    description: z.string().max(256).optional(),
    events: z.array(WebhookEventType).min(1).max(32),
  })
  .openapi('WebhookCreateRequest', {
    description: 'Payload for `POST /api/v1/webhooks`.',
  });
export type WebhookCreateRequest = z.infer<typeof WebhookCreateRequest>;

export const WebhookUpdateRequest = z
  .object({
    url: HttpsUrl.optional(),
    description: z.string().max(256).nullable().optional(),
    events: z.array(WebhookEventType).min(1).max(32).optional(),
    active: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field must be provided.',
  })
  .openapi('WebhookUpdateRequest', {
    description: 'Payload for `PATCH /api/v1/webhooks/:id`.',
  });
export type WebhookUpdateRequest = z.infer<typeof WebhookUpdateRequest>;

export const WebhookDeliverySummary = z
  .object({
    id: WebhookDeliveryId,
    subscriptionId: WebhookSubscriptionId,
    eventId: z.uuid(),
    eventType: WebhookEventType,
    status: WebhookDeliveryStatus,
    httpStatusCode: z.number().int().min(0).max(599).nullable(),
    attempts: SafeCount,
    nextAttemptAt: DateTimeIso.nullable(),
    lastError: z.string().max(2048).nullable(),
    createdAt: DateTimeIso,
    deliveredAt: DateTimeIso.nullable(),
    latencyMs: z.number().int().min(0).nullable(),
  })
  .openapi('WebhookDeliverySummary', {
    description: 'Single webhook delivery attempt record.',
  });
export type WebhookDeliverySummary = z.infer<typeof WebhookDeliverySummary>;

export const WebhookTestRequest = z
  .object({
    eventType: WebhookEventType,
    payloadOverride: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        'Optional override for the event payload. When absent, a canned example for the event type is sent.',
    }),
  })
  .openapi('WebhookTestRequest', {
    description: 'Payload for `POST /api/v1/webhooks/:id/test`.',
  });
export type WebhookTestRequest = z.infer<typeof WebhookTestRequest>;

/**
 * Inbound Didit webhook payload. This is the verbatim body that Didit
 * posts to `POST /api/webhooks/didit`. We parse it with this schema so
 * the handler can reject malformed submissions before doing any work.
 *
 * `vendor_data` is the JSON-stringified blob we stamped on the session
 * at creation time. Two shapes are valid: customer-initiated sessions
 * carry `{type:'customer', crivacySessionId, customerId}`; B2B
 * firm-initiated sessions carry `{type:'b2b', crivacySessionId,
 * firmId, userRef}`. The runtime parser
 * (`lib/didit/vendor-data.ts::parseSessionVendorData`) is the single
 * source of truth — this OpenAPI schema is documentation-only and must
 * stay in sync with that helper.
 */
const DiditVendorDataCustomer = z
  .object({
    type: z.literal('customer'),
    crivacySessionId: z.string().min(1).max(64),
    customerId: z.string().min(1).max(64),
  })
  .strict();

const DiditVendorDataB2b = z
  .object({
    type: z.literal('b2b'),
    crivacySessionId: z.string().min(1).max(64),
    firmId: z.string().min(1).max(64),
    userRef: z.string().min(1).max(255),
  })
  .strict();

export const DiditWebhookPayload = z
  .object({
    session_id: z.string().min(1).max(128),
    status: z.enum(['Approved', 'Declined', 'In Review', 'In Progress', 'Expired']),
    workflow_id: z.string().min(1).max(128),
    vendor_data: z.union([DiditVendorDataCustomer, DiditVendorDataB2b]),
    decision: z
      .object({
        identity_verification: z
          .object({
            status: z.enum(['Approved', 'Declined', 'Not Processed']),
            score: z.number().min(0).max(100).optional(),
          })
          .strict()
          .optional(),
        liveness: z
          .object({
            status: z.enum(['Approved', 'Declined', 'Not Processed']),
            score: z.number().min(0).max(100).optional(),
          })
          .strict()
          .optional(),
        face_match: z
          .object({
            status: z.enum(['Approved', 'Declined', 'Not Processed']),
            score: z.number().min(0).max(100).optional(),
          })
          .strict()
          .optional(),
        aml: z
          .object({
            status: z.enum(['Approved', 'Declined', 'Not Processed']),
            hits: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    created_at: DateTimeIso,
  })
  .strict()
  .openapi('DiditWebhookPayload', {
    description: 'Verbatim inbound payload from Didit’s webhook. Strict shape.',
  });
export type DiditWebhookPayload = z.infer<typeof DiditWebhookPayload>;

/**
 * Canonical outbound webhook envelope. Every event Crivacy pushes to a
 * firm-owned URL is wrapped in this shape.
 */
export const OutboundWebhookEnvelope = z
  .object({
    id: z.uuid().openapi({ description: 'Unique delivery id.' }),
    type: WebhookEventType,
    createdAt: DateTimeIso,
    // `firmId` intentionally omitted — the receiving firm already
    // identifies itself via its signing secret / API key, so echoing
    // the firm id back in the body is redundant and confuses
    // multi-recipient fan-out (user-scope events reach every firm
    // the user has a relationship with; "whose firmId is this?" is
    // an ambiguous question for those recipients).
    data: z.record(z.string(), z.unknown()).openapi({
      description:
        'Event payload. Shape depends on the event type — see the webhook events guide in the dashboard.',
    }),
    sessionId: KycSessionId.nullable(),
  })
  .openapi('OutboundWebhookEnvelope', {
    description: 'Envelope for every outbound webhook delivery.',
  });
export type OutboundWebhookEnvelope = z.infer<typeof OutboundWebhookEnvelope>;

// OutboundWebhookEnvelope is part of the public contract that firms parse
// at their webhook receiver, but it is never the body of a request handled
// by Crivacy itself — it is only ever produced by the delivery worker. The
// generator does not pull it into `components.schemas` automatically, so
// register it explicitly to keep the spec self-documenting.
registry.register('OutboundWebhookEnvelope', OutboundWebhookEnvelope);
