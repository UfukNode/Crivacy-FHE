/**
 * Central webhook emission helpers.
 *
 * Every domain mutation that fires a webhook — customer self-revoke,
 * Didit decision, credential pipeline, admin panel actions, fraud
 * ban, expire worker — funnels through one of the two helpers in
 * this module instead of duplicating the `createWebhookEvent` +
 * fan-out dance at each call site.
 *
 *   * `emitUserEvent` — user-scoped events (credential.*, kyc.session.*).
 *     Dispatch reaches every firm the user has a relationship with:
 *     OAuth consent row, or a credential minted on their behalf by
 *     that firm's B2B session. See
 *     {@link findEndpointsForUserEvent}.
 *
 *   * `emitFirmEvent` — firm-scoped events (oauth.consent.*).
 *     Dispatch stays on the one firm that owns the consent or
 *     client.
 *
 * Both helpers write a `webhook_events` row (so the audit / admin
 * surface can still query by owner firm), then open one delivery
 * row per matching endpoint. Actual HTTP POST is the worker's job
 * in a later stage. Delivery failures do not throw upstream — the
 * caller has already committed the state change, and a lost
 * webhook is the worker's to retry, not the caller's.
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';
import {
  createDelivery,
  createWebhookEvent,
  findEndpointsForEvent,
  findEndpointsForUserEvent,
} from '@/server/repositories/webhooks';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmitBaseInput {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly sourceSessionId?: string;
  readonly sourceCredentialId?: string;
  readonly idempotencyKey?: string;
  readonly now: Date;
}

export interface EmitUserEventInput extends EmitBaseInput {
  /** The customer (Crivacy subject) whose state is changing. */
  readonly customerId: string;
  /**
   * Creator/owner firm id stored on `webhook_events.firm_id` for
   * audit + admin queries. Does NOT gate delivery — fan-out
   * resolves recipient firms from the customer's relationships.
   * Typically the self-service firm for user-direct flows, or the
   * calling firm for B2B-originated events.
   */
  readonly ownerFirmId: string;
}

export interface EmitFirmEventInput extends EmitBaseInput {
  /**
   * The firm this event belongs to AND the only recipient (for
   * firm-scoped events such as OAuth consent lifecycle).
   */
  readonly firmId: string;
}

export interface EmitResult {
  readonly eventId: string;
  readonly deliveryCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function optionalFields(input: EmitBaseInput): {
  sourceSessionId?: string;
  sourceCredentialId?: string;
  idempotencyKey?: string;
} {
  const out: {
    sourceSessionId?: string;
    sourceCredentialId?: string;
    idempotencyKey?: string;
  } = {};
  if (input.sourceSessionId !== undefined) out.sourceSessionId = input.sourceSessionId;
  if (input.sourceCredentialId !== undefined) out.sourceCredentialId = input.sourceCredentialId;
  if (input.idempotencyKey !== undefined) out.idempotencyKey = input.idempotencyKey;
  return out;
}

// ---------------------------------------------------------------------------
// User-scoped emission
// ---------------------------------------------------------------------------

/**
 * Emit a user-scoped webhook event.
 *
 * Writes one `webhook_events` row attributed to `ownerFirmId` and
 * creates one `webhook_deliveries` row per subscribed endpoint
 * across every firm that holds a live relationship with the user
 * (OAuth consent or B2B credential).
 */
export async function emitUserEvent(
  db: CrivacyDatabase,
  input: EmitUserEventInput,
): Promise<EmitResult> {
  const event = await createWebhookEvent(db, {
    firmId: input.ownerFirmId,
    type: input.type,
    payload: input.payload,
    ...optionalFields(input),
  });

  const endpoints = await findEndpointsForUserEvent(db, input.customerId, input.type);
  let deliveryCount = 0;
  for (const endpoint of endpoints) {
    await createDelivery(db, {
      endpointId: endpoint.id,
      eventId: event.id,
      // Multi-firm fan-out: each endpoint may belong to a
      // different firm, so the delivery's denormalized firm scope
      // is the endpoint's firm — NOT the event's `ownerFirmId`.
      // Cat 34b Faz 12 RLS gates rely on this column matching
      // `webhook_endpoints.firm_id`, and findEndpointsForUserEvent
      // already loaded that value from the endpoint row.
      firmId: endpoint.firmId,
      nextRetryAt: input.now,
    });
    deliveryCount += 1;
  }
  return { eventId: event.id, deliveryCount };
}

// ---------------------------------------------------------------------------
// Firm-scoped emission
// ---------------------------------------------------------------------------

/**
 * Emit a firm-scoped webhook event. Dispatch stays on the single
 * firm the event belongs to — used for OAuth consent lifecycle
 * where the payload is meaningful only to that one client's firm.
 */
export async function emitFirmEvent(
  db: CrivacyDatabase,
  input: EmitFirmEventInput,
): Promise<EmitResult> {
  const event = await createWebhookEvent(db, {
    firmId: input.firmId,
    type: input.type,
    payload: input.payload,
    ...optionalFields(input),
  });

  const endpoints = await findEndpointsForEvent(db, input.firmId, input.type);
  let deliveryCount = 0;
  for (const endpoint of endpoints) {
    await createDelivery(db, {
      endpointId: endpoint.id,
      eventId: event.id,
      // Single-firm dispatch: every endpoint here belongs to
      // `input.firmId` by construction (findEndpointsForEvent
      // filters on it), so the denormalized scope is the same.
      firmId: input.firmId,
      nextRetryAt: input.now,
    });
    deliveryCount += 1;
  }
  return { eventId: event.id, deliveryCount };
}
