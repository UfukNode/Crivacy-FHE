/**
 * Outbound webhook envelope builder.
 *
 * Produces the canonical `OutboundWebhookEnvelope` shape that Crivacy
 * posts to every firm-owned webhook URL.
 *
 * @module
 */

import { WebhookError } from './errors';

/**
 * Shape of the outbound webhook envelope — matches
 * `OutboundWebhookEnvelope` from the OpenAPI schemas.
 *
 * `firmId` is deliberately NOT echoed back in the payload: the
 * receiving firm authenticates via its own signing secret / API
 * key, so it already knows "who it is". Including a `firmId` was
 * ambiguous under multi-recipient fan-out (one user-scope event
 * reaches every firm the user has a relationship with, and each
 * of them would have a different answer to "whose firmId is
 * this?"). The DB still stores `webhook_events.firm_id` as the
 * event's creator/owner for audit + internal query; the wire
 * contract just doesn't surface it anymore.
 */
export interface WebhookEnvelope {
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly data: Record<string, unknown>;
  readonly sessionId: string | null;
}

/**
 * Input to build an envelope — the data we have from the DB rows.
 */
export interface BuildEnvelopeInput {
  readonly deliveryId: string;
  readonly eventType: string;
  readonly eventCreatedAt: Date;
  readonly payload: Record<string, unknown>;
  readonly sourceSessionId: string | null;
}

/**
 * Build the outbound webhook envelope from DB row data.
 *
 * @param input - Data from webhook_events + webhook_deliveries
 * @returns Frozen envelope ready for JSON serialization
 */
export function buildEnvelope(input: BuildEnvelopeInput): WebhookEnvelope {
  if (input.deliveryId.length === 0) {
    throw new WebhookError('invalid_envelope', 'Delivery ID must not be empty.');
  }
  if (input.eventType.length === 0) {
    throw new WebhookError('invalid_envelope', 'Event type must not be empty.');
  }

  return Object.freeze({
    id: input.deliveryId,
    type: input.eventType,
    createdAt: input.eventCreatedAt.toISOString(),
    data: input.payload,
    sessionId: input.sourceSessionId,
  });
}

/**
 * Serialize an envelope to a JSON string. This is the body that gets
 * signed with HMAC and sent to the firm's URL.
 */
export function serializeEnvelope(envelope: WebhookEnvelope): string {
  return JSON.stringify(envelope);
}
