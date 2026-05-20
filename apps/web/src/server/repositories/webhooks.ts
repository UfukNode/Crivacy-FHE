/**
 * Webhook repository — data access for `webhook_endpoints`,
 * `webhook_events`, and `webhook_deliveries`.
 *
 * @module
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { webhookDeliveries, webhookEndpoints, webhookEvents } from '@/lib/db/schema';
import type { WebhookDelivery, WebhookEndpoint, WebhookEvent } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Endpoints — CRUD
// ---------------------------------------------------------------------------

export interface CreateEndpointInput {
  readonly firmId: string;
  readonly label: string;
  readonly url: string;
  readonly events: string[];
  readonly signingSecretCiphertext: Uint8Array;
  readonly signingSecretNonce: Uint8Array;
  readonly signingKeyVersion: number;
}

export async function createEndpoint(
  db: CrivacyDatabase,
  input: CreateEndpointInput,
): Promise<WebhookEndpoint> {
  const rows = await db
    .insert(webhookEndpoints)
    .values({
      firmId: input.firmId,
      label: input.label,
      url: input.url,
      events: input.events,
      signingSecretCiphertext: input.signingSecretCiphertext,
      signingSecretNonce: input.signingSecretNonce,
      signingKeyVersion: input.signingKeyVersion,
    })
    .returning();

  const row = rows[0];
  if (row === undefined) {
    throw new Error('Webhook endpoint insert returned no rows.');
  }
  return row;
}

export async function findEndpointById(
  db: CrivacyDatabase,
  firmId: string,
  endpointId: string,
): Promise<WebhookEndpoint | null> {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.firmId, firmId)))
    .limit(1);

  return rows[0] ?? null;
}

export async function listEndpoints(
  db: CrivacyDatabase,
  firmId: string,
  options: { cursor?: { ts: Date; id: string }; limit: number },
): Promise<{ items: readonly WebhookEndpoint[]; nextCursor: { ts: Date; id: string } | null }> {
  const conditions = [eq(webhookEndpoints.firmId, firmId)];

  if (options.cursor !== undefined) {
    conditions.push(
      sql`(${webhookEndpoints.createdAt}, ${webhookEndpoints.id}) < (${options.cursor.ts}, ${options.cursor.id})`,
    );
  }

  const fetchLimit = options.limit + 1;
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(and(...conditions))
    .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id))
    .limit(fetchLimit);

  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;

  let nextCursor: { ts: Date; id: string } | null = null;
  if (hasMore) {
    const last = items[items.length - 1];
    if (last !== undefined) {
      nextCursor = { ts: last.createdAt, id: last.id };
    }
  }

  return { items, nextCursor };
}

export async function updateEndpoint(
  db: CrivacyDatabase,
  firmId: string,
  endpointId: string,
  update: {
    label?: string;
    url?: string;
    events?: string[];
    disabledAt?: Date | null;
    disabledReason?: string | null;
  },
): Promise<WebhookEndpoint | null> {
  const rows = await db
    .update(webhookEndpoints)
    .set({
      ...(update.label !== undefined ? { label: update.label } : {}),
      ...(update.url !== undefined ? { url: update.url } : {}),
      ...(update.events !== undefined ? { events: update.events } : {}),
      ...(update.disabledAt !== undefined ? { disabledAt: update.disabledAt } : {}),
      ...(update.disabledReason !== undefined ? { disabledReason: update.disabledReason } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.firmId, firmId)))
    .returning();

  return rows[0] ?? null;
}

export async function deleteEndpoint(
  db: CrivacyDatabase,
  firmId: string,
  endpointId: string,
): Promise<boolean> {
  const rows = await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.firmId, firmId)))
    .returning({ id: webhookEndpoints.id });

  return rows.length > 0;
}

export async function countEndpointsByFirm(db: CrivacyDatabase, firmId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.firmId, firmId));

  return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Deliveries — read-only for the API layer
// ---------------------------------------------------------------------------

export type DeliveryWithEventType = WebhookDelivery & { readonly eventType: string };

export async function listDeliveries(
  db: CrivacyDatabase,
  endpointId: string,
  options: { cursor?: { ts: Date; id: string }; limit: number },
): Promise<{ items: readonly DeliveryWithEventType[]; nextCursor: { ts: Date; id: string } | null }> {
  const conditions = [eq(webhookDeliveries.endpointId, endpointId)];

  if (options.cursor !== undefined) {
    conditions.push(
      sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${options.cursor.ts}, ${options.cursor.id})`,
    );
  }

  const fetchLimit = options.limit + 1;
  const rows = await db
    .select({
      delivery: webhookDeliveries,
      eventType: webhookEvents.type,
    })
    .from(webhookDeliveries)
    .innerJoin(webhookEvents, eq(webhookDeliveries.eventId, webhookEvents.id))
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(fetchLimit);

  const mapped: DeliveryWithEventType[] = rows.map((r) => ({
    ...r.delivery,
    eventType: r.eventType,
  }));

  const hasMore = mapped.length > options.limit;
  const items = hasMore ? mapped.slice(0, options.limit) : mapped;

  let nextCursor: { ts: Date; id: string } | null = null;
  if (hasMore) {
    const last = items[items.length - 1];
    if (last !== undefined) {
      nextCursor = { ts: last.createdAt, id: last.id };
    }
  }

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Events — write (for test event + webhook trigger)
// ---------------------------------------------------------------------------

export async function createWebhookEvent(
  db: CrivacyDatabase,
  input: {
    firmId: string;
    type: string;
    payload: Record<string, unknown>;
    sourceSessionId?: string;
    sourceCredentialId?: string;
    idempotencyKey?: string;
  },
): Promise<WebhookEvent> {
  const rows = await db
    .insert(webhookEvents)
    .values({
      firmId: input.firmId,
      type: input.type,
      payload: input.payload,
      ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.sourceCredentialId !== undefined
        ? { sourceCredentialId: input.sourceCredentialId }
        : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    })
    .returning();

  const row = rows[0];
  if (row === undefined) {
    throw new Error('Webhook event insert returned no rows.');
  }
  return row;
}

export async function createDelivery(
  db: CrivacyDatabase,
  input: {
    endpointId: string;
    eventId: string;
    /**
     * Denormalized firm scope — Cat 34b Faz 12. MUST equal the
     * `firm_id` of the endpoint named in `endpointId`; the database
     * cannot enforce that with a single FK so callers carry the
     * invariant. `emit*Event` reads it from the endpoint row that
     * fan-out already loaded; `handleTestWebhook` passes the
     * caller's `ctx.firm.id` (always equal to the endpoint's firm
     * because the endpoint is firm-scoped by the dashboard).
     */
    firmId: string;
    maxAttempts?: number;
    nextRetryAt?: Date;
  },
): Promise<WebhookDelivery> {
  const rows = await db
    .insert(webhookDeliveries)
    .values({
      endpointId: input.endpointId,
      eventId: input.eventId,
      firmId: input.firmId,
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      ...(input.nextRetryAt !== undefined ? { nextRetryAt: input.nextRetryAt } : {}),
    })
    .returning();

  const row = rows[0];
  if (row === undefined) {
    throw new Error('Webhook delivery insert returned no rows.');
  }
  return row;
}

/**
 * Find all endpoints for a firm that subscribe to a given event type.
 * Used to fan out a domain event to matching subscriptions.
 *
 * Firm-scope fan-out — caller already knows which single firm owns
 * the event (e.g. OAuth consent events carry a specific client's
 * firm). For user-scope events (credential / kyc.session family)
 * that should reach every firm the user has a relationship with,
 * use {@link findEndpointsForUserEvent} instead.
 */
export async function findEndpointsForEvent(
  db: CrivacyDatabase,
  firmId: string,
  eventType: string,
): Promise<readonly WebhookEndpoint[]> {
  return db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.firmId, firmId),
        sql`${webhookEndpoints.disabledAt} IS NULL`,
        sql`${webhookEndpoints.circuitBreakerTrippedAt} IS NULL`,
        sql`${eventType} = ANY(${webhookEndpoints.events})`,
      ),
    );
}

/**
 * Find every endpoint that should receive a **user-scoped** event.
 *
 * "User-scoped" events (credential.*, kyc.session.*) belong to a
 * person, not a single firm, so every firm the person has granted
 * access to must hear about state changes. Recipient set is the
 * union of:
 *
 *   1. Firms that own an active OAuth client the user has granted
 *      consent to (`oauth_consents` join `oauth_clients`).
 *   2. Firms that own a credential minted for the user — i.e. B2B
 *      sessions initiated by the firm where `user_ref = customerId`.
 *
 * Crivacy's own self-service firm is deliberately skipped: we don't
 * HTTP-POST to ourselves (in-process events + DB are already the
 * source of truth). Final filter: endpoint must be enabled, not
 * circuit-broken, and subscribed to the event type.
 *
 * The subquery uses `DISTINCT` + `UNION` so a firm with both paths
 * to the user (OAuth consent *and* a B2B credential) only receives
 * one copy of the event.
 */
export async function findEndpointsForUserEvent(
  db: CrivacyDatabase,
  customerId: string,
  eventType: string,
): Promise<readonly WebhookEndpoint[]> {
  const selfServiceFirmId = process.env['CRIVACY_SELF_SERVICE_FIRM_ID'] ?? '';
  const result = await db.execute<WebhookEndpoint>(sql`
    SELECT we.*
    FROM webhook_endpoints we
    WHERE we.firm_id IN (
      SELECT DISTINCT oc_cli.firm_id
      FROM oauth_consents oc
      JOIN oauth_clients oc_cli ON oc_cli.id = oc.oauth_client_id
      WHERE oc.user_id = ${customerId}
        AND oc.revoked_at IS NULL
      UNION
      SELECT DISTINCT kc.firm_id
      FROM kyc_credentials_meta kc
      WHERE kc.user_ref = ${customerId}
    )
    AND we.firm_id <> ${selfServiceFirmId}
    AND we.disabled_at IS NULL
    AND we.circuit_breaker_tripped_at IS NULL
    AND ${eventType} = ANY(we.events)
  `);
  // `db.execute` returns a driver-specific QueryResult — the iterable
  // rows live under `result.rows` (matches `kyc-reconciler-worker`'s
  // sibling pattern). The SELECT star produces a row whose column
  // names line up with the Drizzle schema, so a `unknown` cast is
  // sufficient.
  return result.rows as unknown as readonly WebhookEndpoint[];
}
