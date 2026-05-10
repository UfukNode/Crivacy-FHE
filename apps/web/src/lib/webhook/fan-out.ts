/**
 * Event fan-out — creates webhook deliveries for all matching endpoints.
 *
 * When a domain event occurs (credential.created, kyc.session.approved,
 * etc.), the caller inserts a `webhook_events` row and then calls
 * `fanOutEvent` to create one `webhook_deliveries` row per matching
 * endpoint subscription.
 *
 * @module
 */

import { WebhookError } from './errors';

/* ---------- Types ---------- */

/**
 * Minimal endpoint shape needed for fan-out decisions.
 */
export interface FanOutEndpoint {
  readonly id: string;
  readonly maxAttempts: number;
}

/**
 * Result of a fan-out operation.
 */
export interface FanOutResult {
  readonly eventId: string;
  readonly eventType: string;
  readonly endpointIds: readonly string[];
  readonly deliveryCount: number;
}

/**
 * Input for the fan-out function.
 */
export interface FanOutInput {
  readonly eventId: string;
  readonly eventType: string;
  readonly firmId: string;
}

/**
 * Abstracts DB operations so fan-out stays testable.
 */
export interface FanOutDeps {
  /** Find all active endpoints for a firm that subscribe to the event type. */
  findEndpoints(firmId: string, eventType: string): Promise<readonly FanOutEndpoint[]>;
  /** Create a delivery record. */
  createDelivery(input: {
    endpointId: string;
    eventId: string;
    /**
     * Denormalized firm scope — Cat 34b Faz 12. Carries the
     * endpoint's `firm_id` so RLS policies on
     * `webhook_deliveries` gate by direct equality. Equal to
     * `FanOutInput.firmId` here because the wrapping
     * `fanOutEvent` only fans out single-firm events.
     */
    firmId: string;
    maxAttempts: number;
    nextRetryAt: Date;
  }): Promise<{ id: string }>;
}

/* ---------- Core ---------- */

/**
 * Fan out a webhook event to all matching endpoint subscriptions.
 *
 * @param deps - DB operation abstractions
 * @param input - Event metadata
 * @param now - Current time (for nextRetryAt = immediate)
 * @returns Fan-out result with created delivery IDs
 */
export async function fanOutEvent(
  deps: FanOutDeps,
  input: FanOutInput,
  now: Date = new Date(),
): Promise<FanOutResult> {
  if (input.eventId.length === 0) {
    throw new WebhookError('invalid_event', 'Event ID must not be empty.');
  }
  if (input.eventType.length === 0) {
    throw new WebhookError('invalid_event', 'Event type must not be empty.');
  }

  let endpoints: readonly FanOutEndpoint[];
  try {
    endpoints = await deps.findEndpoints(input.firmId, input.eventType);
  } catch (err) {
    throw WebhookError.wrap('fan_out_failed', err, {
      firmId: input.firmId,
      eventType: input.eventType,
    });
  }

  const endpointIds: string[] = [];

  for (const ep of endpoints) {
    try {
      await deps.createDelivery({
        endpointId: ep.id,
        eventId: input.eventId,
        firmId: input.firmId,
        maxAttempts: ep.maxAttempts,
        nextRetryAt: now,
      });
      endpointIds.push(ep.id);
    } catch (err) {
      // If a single delivery creation fails (e.g., duplicate), continue
      // with the rest. The idempotency index on (endpoint_id, event_id)
      // will reject duplicates safely.
      if (isDuplicateError(err)) {
        endpointIds.push(ep.id);
        continue;
      }
      throw WebhookError.wrap('fan_out_failed', err, {
        endpointId: ep.id,
        eventId: input.eventId,
      });
    }
  }

  return Object.freeze({
    eventId: input.eventId,
    eventType: input.eventType,
    endpointIds: Object.freeze(endpointIds),
    deliveryCount: endpointIds.length,
  });
}

/* ---------- Helpers ---------- */

function isDuplicateError(err: unknown): boolean {
  if (err instanceof Error) {
    // PostgreSQL unique_violation
    return err.message.includes('unique') || err.message.includes('duplicate');
  }
  return false;
}
