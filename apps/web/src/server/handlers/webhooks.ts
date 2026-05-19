/**
 * Webhook handlers — business logic for `/api/v1/webhooks`.
 *
 * @module
 */

import type { NextResponse } from 'next/server';

import { loadKeyFromBase64, seal } from '@/lib/auth/crypto-box';
import { acquireFirmResourceLock } from '@/lib/db/advisory-lock';
import type { WebhookEndpoint } from '@/lib/db/schema';
import type { DeliveryWithEventType } from '../repositories';
import { PaginationQuery } from '@/lib/openapi/common/pagination';
import {
  WebhookCreateRequest,
  WebhookTestRequest,
  WebhookUpdateRequest,
} from '@/lib/openapi/schemas/webhook';
import { DEFAULT_TIER_LIMITS } from '@/lib/ratelimit/tiers';
import { ensureWebhookUrlSafe } from '@/lib/security/webhook-url-guard';
import { z } from 'zod';
import type { AuthenticatedContext } from '../context';
import { parseBody, parsePathParams, parseQuery } from '../middleware/parse';
import {
  countEndpointsByFirm,
  createDelivery,
  createEndpoint,
  createWebhookEvent,
  deleteEndpoint,
  findEndpointById,
  listDeliveries,
  listEndpoints,
  updateEndpoint,
} from '../repositories';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PathIdParams = z.object({
  id: z.uuid(),
});

function encodeCursor(cursor: { ts: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ ts: cursor.ts.toISOString(), id: cursor.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { ts: Date; id: string } | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj['ts'] !== 'string' || typeof obj['id'] !== 'string') return null;
    const ts = new Date(obj['ts']);
    if (Number.isNaN(ts.getTime())) return null;
    return { ts, id: obj['id'] };
  } catch {
    return null;
  }
}

function endpointToSummary(ep: WebhookEndpoint) {
  return {
    id: ep.id,
    firmId: ep.firmId,
    url: ep.url,
    description: ep.label || null,
    events: ep.events,
    active: ep.disabledAt === null,
    secretMasked: 'whsec_••••••••••••••••', // Encrypted at rest — full value shown only at creation
    createdAt: ep.createdAt.toISOString(),
    updatedAt: ep.updatedAt.toISOString(),
    lastDeliveryAt: ep.lastSuccessAt?.toISOString() ?? null,
    failureCount: ep.consecutiveFailures,
  };
}

function deliveryToSummary(d: DeliveryWithEventType) {
  return {
    id: d.id,
    subscriptionId: d.endpointId,
    eventId: d.eventId,
    eventType: d.eventType,
    status: d.status,
    httpStatusCode: d.lastHttpStatus,
    attempts: d.attempts,
    nextAttemptAt: d.nextRetryAt?.toISOString() ?? null,
    lastError: d.lastError,
    createdAt: d.createdAt.toISOString(),
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    latencyMs: null, // Not tracked in current schema
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/webhooks — list webhook subscriptions.
 */
export async function handleListWebhooks(ctx: AuthenticatedContext): Promise<NextResponse> {
  const url = new URL(ctx.request.url);
  const query = parseQuery(url, PaginationQuery);

  const cursor = query.cursor !== undefined ? decodeCursor(query.cursor) : null;
  const limit = query.limit ?? 25;

  const opts: { cursor?: { ts: Date; id: string }; limit: number } = { limit };
  if (cursor !== null) opts.cursor = cursor;

  const result = await listEndpoints(ctx.db, ctx.firm.id, opts);

  return ctx.json({
    data: result.items.map(endpointToSummary),
    pagination: {
      nextCursor: result.nextCursor !== null ? encodeCursor(result.nextCursor) : null,
      limit,
    },
  });
}

/**
 * POST /api/v1/webhooks — create a webhook subscription.
 */
export async function handleCreateWebhook(ctx: AuthenticatedContext): Promise<NextResponse> {
  const body = await parseBody(ctx.request, WebhookCreateRequest);

  // SSRF guard — reject URLs that resolve to loopback / private /
  // link-local / cloud-metadata ranges before spending a tier slot.
  const urlCheck = await ensureWebhookUrlSafe(body.url);
  if (!urlCheck.ok) {
    return ctx.errorJson('validation_error', urlCheck.reason, 400);
  }

  // Resolve tier cap up front so the lock window stays minimal.
  const tier = ctx.firm.tier as keyof typeof DEFAULT_TIER_LIMITS;
  const tierLimits = DEFAULT_TIER_LIMITS[tier];
  const capSlots =
    tierLimits !== undefined && tierLimits.webhookEndpoints !== null
      ? tierLimits.webhookEndpoints
      : null;

  // Generate + encrypt the signing secret outside the transaction.
  // The bcrypt-equivalent cost for AES-GCM-sealing a 32-byte secret
  // is negligible, but the principle holds: never hold the lock
  // over work that doesn't mutate the lock's target resource.
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secretHex = Array.from(secretBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const secret = `whsec_${secretHex}`;

  // Encrypt the secret for storage.
  // The key is loaded from AUTH_WEBHOOK_ENCRYPTION_KEY env var at startup.
  // loadKeyFromBase64 validates it is exactly 32 bytes (AES-256).
  const keyBase64 = process.env['AUTH_WEBHOOK_ENCRYPTION_KEY'] ?? '';
  const key = loadKeyFromBase64(keyBase64);
  const sealed = seal(secret, key, 1);

  // Atomic tier check + insert. Same race the dashboard create
  // flow had: two concurrent API calls with the same api-key at
  // the cap boundary would both read the pre-insert count and
  // both add endpoints, sneaking one past the tier ceiling. The
  // per-firm advisory lock forces the second caller to wait,
  // re-read the count, and bail with `tier_forbidden` when the
  // first insert already filled the slot.
  const result = await ctx.db.transaction(async (tx) => {
    await acquireFirmResourceLock(tx, ctx.firm.id, 'webhook_endpoints');

    if (capSlots !== null) {
      const currentCount = await countEndpointsByFirm(tx, ctx.firm.id);
      if (currentCount >= capSlots) {
        return { status: 'tier_exceeded', maxSlots: capSlots } as const;
      }
    }

    const endpoint = await createEndpoint(tx, {
      firmId: ctx.firm.id,
      label: body.description ?? '',
      url: urlCheck.normalised,
      events: body.events,
      signingSecretCiphertext: sealed.ciphertext,
      signingSecretNonce: sealed.nonce,
      signingKeyVersion: 1,
    });
    return { status: 'inserted', endpoint } as const;
  });

  if (result.status === 'tier_exceeded') {
    return ctx.errorJson(
      'tier_forbidden',
      `Your ${ctx.firm.tier} tier allows at most ${String(result.maxSlots)} webhook subscriptions.`,
      403,
    );
  }

  return ctx.json(
    {
      ...endpointToSummary(result.endpoint),
      secret,
    },
    201,
  );
}

/**
 * GET /api/v1/webhooks/:id — read a webhook subscription.
 */
export async function handleGetWebhook(
  ctx: AuthenticatedContext,
  params: Promise<Record<string, string | string[]>>,
): Promise<NextResponse> {
  const { id } = await parsePathParams(params, PathIdParams);

  const endpoint = await findEndpointById(ctx.db, ctx.firm.id, id);
  if (endpoint === null) {
    return ctx.errorJson('not_found', `Webhook subscription "${id}" not found.`, 404);
  }

  return ctx.json(endpointToSummary(endpoint));
}

/**
 * PATCH /api/v1/webhooks/:id — update a webhook subscription.
 */
export async function handleUpdateWebhook(
  ctx: AuthenticatedContext,
  params: Promise<Record<string, string | string[]>>,
): Promise<NextResponse> {
  const { id } = await parsePathParams(params, PathIdParams);
  const body = await parseBody(ctx.request, WebhookUpdateRequest);

  const existing = await findEndpointById(ctx.db, ctx.firm.id, id);
  if (existing === null) {
    return ctx.errorJson('not_found', `Webhook subscription "${id}" not found.`, 404);
  }

  // SSRF guard on update — same vector applies to URL edits.
  let normalisedUrl: string | undefined;
  if (body.url !== undefined) {
    const urlCheck = await ensureWebhookUrlSafe(body.url);
    if (!urlCheck.ok) {
      return ctx.errorJson('validation_error', urlCheck.reason, 400);
    }
    normalisedUrl = urlCheck.normalised;
  }

  const updated = await updateEndpoint(ctx.db, ctx.firm.id, id, {
    ...(normalisedUrl !== undefined ? { url: normalisedUrl } : {}),
    ...(body.description !== undefined ? { label: body.description ?? '' } : {}),
    ...(body.events !== undefined ? { events: body.events } : {}),
    ...(body.active !== undefined
      ? {
          disabledAt: body.active ? null : ctx.now,
          disabledReason: body.active ? null : 'disabled_by_user',
        }
      : {}),
  });

  if (updated === null) {
    return ctx.errorJson('not_found', `Webhook subscription "${id}" not found.`, 404);
  }

  return ctx.json(endpointToSummary(updated));
}

/**
 * DELETE /api/v1/webhooks/:id — hard-delete a webhook subscription.
 */
export async function handleDeleteWebhook(
  ctx: AuthenticatedContext,
  params: Promise<Record<string, string | string[]>>,
): Promise<NextResponse> {
  const { id } = await parsePathParams(params, PathIdParams);

  const deleted = await deleteEndpoint(ctx.db, ctx.firm.id, id);
  if (!deleted) {
    return ctx.errorJson('not_found', `Webhook subscription "${id}" not found.`, 404);
  }

  return ctx.noContent();
}

/**
 * POST /api/v1/webhooks/:id/test — send a test event.
 */
export async function handleTestWebhook(
  ctx: AuthenticatedContext,
  params: Promise<Record<string, string | string[]>>,
): Promise<NextResponse> {
  const { id } = await parsePathParams(params, PathIdParams);
  const body = await parseBody(ctx.request, WebhookTestRequest);

  const endpoint = await findEndpointById(ctx.db, ctx.firm.id, id);
  if (endpoint === null) {
    return ctx.errorJson('not_found', `Webhook subscription "${id}" not found.`, 404);
  }

  // Create a synthetic webhook event
  const event = await createWebhookEvent(ctx.db, {
    firmId: ctx.firm.id,
    type: body.eventType,
    payload: body.payloadOverride ?? { test: true, timestamp: ctx.now.toISOString() },
  });

  // Create a delivery record. The denormalized firm scope (Cat 34b
  // Faz 12) is `ctx.firm.id` — same as the endpoint's firm because
  // `findEndpointById` already filtered on `ctx.firm.id` two
  // statements above, so cross-firm test triggers are impossible
  // by construction.
  const delivery = await createDelivery(ctx.db, {
    endpointId: endpoint.id,
    eventId: event.id,
    firmId: ctx.firm.id,
    nextRetryAt: ctx.now,
  });

  return ctx.json(deliveryToSummary({ ...delivery, eventType: body.eventType }), 202);
}

/**
 * GET /api/v1/webhooks/:id/deliveries — list delivery attempts.
 */
export async function handleListDeliveries(
  ctx: AuthenticatedContext,
  params: Promise<Record<string, string | string[]>>,
): Promise<NextResponse> {
  const { id } = await parsePathParams(params, PathIdParams);
  const url = new URL(ctx.request.url);
  const query = parseQuery(url, PaginationQuery);

  // Verify endpoint ownership
  const endpoint = await findEndpointById(ctx.db, ctx.firm.id, id);
  if (endpoint === null) {
    return ctx.errorJson('not_found', `Webhook subscription "${id}" not found.`, 404);
  }

  const cursor = query.cursor !== undefined ? decodeCursor(query.cursor) : null;
  const limit = query.limit ?? 25;

  const opts: { cursor?: { ts: Date; id: string }; limit: number } = { limit };
  if (cursor !== null) opts.cursor = cursor;

  const result = await listDeliveries(ctx.db, id, opts);

  return ctx.json({
    data: result.items.map(deliveryToSummary),
    pagination: {
      nextCursor: result.nextCursor !== null ? encodeCursor(result.nextCursor) : null,
      limit,
    },
  });
}
