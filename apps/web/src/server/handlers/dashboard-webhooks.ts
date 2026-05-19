/**
 * Dashboard webhook management handlers — deliveries + replay, plus
 * the full endpoint CRUD surface the firm's dashboard uses to manage
 * its subscriptions.
 *
 * The parallel public surface at `/api/v1/webhooks/*` authenticates
 * with API keys; this module drives the `/api/internal/webhooks/*`
 * routes which authenticate with the dashboard session cookie.
 * Both surfaces share the same repository functions, the same Zod
 * validation schemas, and the same response DTO shape via
 * `_webhook-shared` — which is what keeps them from drifting.
 *
 * @module
 */

import { firmUserActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { acquireFirmResourceLock } from '@/lib/db/advisory-lock';
import {
  WebhookCreateRequest,
  WebhookUpdateRequest,
} from '@/lib/openapi/schemas/webhook';
import { DEFAULT_TIER_LIMITS } from '@/lib/ratelimit/tiers';
import { ensureWebhookUrlSafe } from '@/lib/security/webhook-url-guard';
import {
  countEndpointsByFirm,
  createEndpoint,
  deleteEndpoint,
  findEndpointById,
  listEndpoints,
  updateEndpoint,
} from '../repositories';
import {
  encodeWebhookCursor,
  endpointToSummary,
  generateSigningSecret,
  type WebhookEndpointSummary,
} from './_webhook-shared';
import type { DashboardContext } from '../context';

/* ---------- Types ---------- */

export interface DeliveryListItem {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly status: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly httpStatus: number | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
  readonly nextRetryAt: Date | null;
}

export interface DeliveryListResult {
  readonly deliveries: readonly DeliveryListItem[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly cursor: string | null;
}

/* ---------- DI ---------- */

export interface WebhookDeliveryDeps {
  readonly listDeliveries: (
    ctx: DashboardContext,
    opts: {
      readonly endpointId?: string;
      readonly status?: string;
      readonly limit?: number;
      readonly cursor?: string;
    },
  ) => Promise<DeliveryListResult>;
  readonly replayDelivery: (
    ctx: DashboardContext,
    deliveryId: string,
  ) => Promise<{ id: string } | null>;
}

/* ---------- Delivery handlers ---------- */

/**
 * List webhook deliveries for the firm.
 */
export async function handleListDeliveries(
  deps: WebhookDeliveryDeps,
  ctx: DashboardContext,
  opts: {
    readonly endpointId?: string;
    readonly status?: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
): Promise<DeliveryListResult> {
  return deps.listDeliveries(ctx, opts);
}

/**
 * Replay a failed delivery. Returns `null` when the delivery does
 * not belong to the caller's firm — the route translates that into
 * a 404 so the response does not distinguish "wrong firm" from
 * "deleted row" (no oracle).
 */
export async function handleReplayDelivery(
  deps: WebhookDeliveryDeps,
  ctx: DashboardContext,
  deliveryId: string,
): Promise<{ id: string } | null> {
  return deps.replayDelivery(ctx, deliveryId);
}

/* ---------- Endpoint CRUD (dashboard) ---------- */

/**
 * Shape of the paginated list response. Uses the same envelope the
 * dashboard's other list surfaces return (`{ data, pagination }`),
 * so an SWR consumer treats webhook lists identically to api-key
 * lists.
 */
export interface DashboardWebhookListResult {
  readonly data: readonly WebhookEndpointSummary[];
  readonly pagination: {
    readonly nextCursor: string | null;
    readonly limit: number;
  };
}

export async function handleDashboardListWebhooks(
  ctx: DashboardContext,
  opts: {
    readonly cursor?: { ts: Date; id: string };
    readonly limit?: number;
  },
): Promise<DashboardWebhookListResult> {
  const limit = opts.limit ?? 25;
  const listOpts: { cursor?: { ts: Date; id: string }; limit: number } = { limit };
  if (opts.cursor !== undefined) listOpts.cursor = opts.cursor;

  const result = await listEndpoints(ctx.db, ctx.firm.id, listOpts);

  return {
    data: result.items.map(endpointToSummary),
    pagination: {
      nextCursor: result.nextCursor !== null ? encodeWebhookCursor(result.nextCursor) : null,
      limit,
    },
  };
}

/**
 * Outcome of create / update / delete — discriminated union so the
 * route layer can translate each case to the right HTTP status
 * without leaking error state into the response body.
 */
export type DashboardWebhookMutationResult =
  | { readonly status: 'created'; readonly summary: WebhookEndpointSummary; readonly secret: string }
  | { readonly status: 'updated'; readonly summary: WebhookEndpointSummary }
  | { readonly status: 'deleted' }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'tier_exceeded';
      readonly tier: string;
      readonly maxSlots: number;
    }
  | { readonly status: 'url_blocked'; readonly reason: string };

export async function handleDashboardCreateWebhook(
  ctx: DashboardContext,
  body: unknown,
): Promise<DashboardWebhookMutationResult> {
  const parsed = WebhookCreateRequest.parse(body);

  // SSRF guard — resolve DNS and reject any URL whose host is a
  // literal or resolves to a loopback / private / link-local / cloud
  // metadata address. Runs before the tier check so a firm doesn't
  // get told "slot full" when the URL was never going to be saved.
  const urlCheck = await ensureWebhookUrlSafe(parsed.url);
  if (!urlCheck.ok) {
    return { status: 'url_blocked', reason: urlCheck.reason };
  }

  // Tier slot check — matches the public API behaviour so a firm
  // can't work around the cap by running the create call through
  // the dashboard instead of the API.
  const tier = ctx.firm.tier as keyof typeof DEFAULT_TIER_LIMITS;
  const tierLimits = DEFAULT_TIER_LIMITS[tier];
  const capSlots =
    tierLimits !== undefined && tierLimits.webhookEndpoints !== null
      ? tierLimits.webhookEndpoints
      : null;

  const secret = generateSigningSecret();

  // Serialise count + insert + audit for this firm inside one
  // transaction guarded by a per-firm advisory lock. Two concurrent
  // "Create webhook" requests for the same firm otherwise both
  // observed the same pre-insert count, both inserted, and both
  // pushed the firm one endpoint over its tier cap — the same
  // TOCTOU pattern that affected oauth_clients and api_keys.
  const outcome = await ctx.db.transaction(async (tx) => {
    await acquireFirmResourceLock(tx, ctx.firm.id, 'webhook_endpoints');

    if (capSlots !== null) {
      const currentCount = await countEndpointsByFirm(tx, ctx.firm.id);
      if (currentCount >= capSlots) {
        return {
          status: 'tier_exceeded',
          tier: ctx.firm.tier,
          maxSlots: capSlots,
        } as const;
      }
    }

    const endpoint = await createEndpoint(tx, {
      firmId: ctx.firm.id,
      label: parsed.description ?? '',
      url: urlCheck.normalised,
      events: [...parsed.events],
      signingSecretCiphertext: secret.ciphertext,
      signingSecretNonce: secret.nonce,
      signingKeyVersion: secret.keyVersion,
    });

    await writeAudit(tx, {
      action: 'webhook.endpoint_created',
      actor: firmUserActor({ id: ctx.user.id, firmId: ctx.firm.id, label: ctx.user.email }),
      target: uuidTarget({ kind: 'webhook_endpoint', id: endpoint.id }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: { url: endpoint.url, events: endpoint.events },
      ts: ctx.now,
    });

    return { status: 'inserted', endpoint } as const;
  });

  if (outcome.status === 'tier_exceeded') {
    return outcome;
  }
  return {
    status: 'created',
    summary: endpointToSummary(outcome.endpoint),
    secret: secret.plaintext,
  };
}

export async function handleDashboardGetWebhook(
  ctx: DashboardContext,
  id: string,
): Promise<WebhookEndpointSummary | null> {
  const endpoint = await findEndpointById(ctx.db, ctx.firm.id, id);
  if (endpoint === null) return null;
  return endpointToSummary(endpoint);
}

export async function handleDashboardUpdateWebhook(
  ctx: DashboardContext,
  id: string,
  body: unknown,
): Promise<DashboardWebhookMutationResult> {
  const parsed = WebhookUpdateRequest.parse(body);

  const existing = await findEndpointById(ctx.db, ctx.firm.id, id);
  if (existing === null) return { status: 'not_found' };

  // SSRF guard on update too — the URL is editable, so the same
  // attack vector applies. Skip the DNS roundtrip when the URL
  // isn't in the patch payload.
  let normalisedUrl: string | undefined;
  if (parsed.url !== undefined) {
    const urlCheck = await ensureWebhookUrlSafe(parsed.url);
    if (!urlCheck.ok) {
      return { status: 'url_blocked', reason: urlCheck.reason };
    }
    normalisedUrl = urlCheck.normalised;
  }

  const updated = await updateEndpoint(ctx.db, ctx.firm.id, id, {
    ...(normalisedUrl !== undefined ? { url: normalisedUrl } : {}),
    ...(parsed.description !== undefined
      ? { label: parsed.description ?? '' }
      : {}),
    ...(parsed.events !== undefined ? { events: [...parsed.events] } : {}),
    ...(parsed.active !== undefined
      ? {
          disabledAt: parsed.active ? null : ctx.now,
          disabledReason: parsed.active ? null : 'disabled_by_user',
        }
      : {}),
  });
  if (updated === null) return { status: 'not_found' };

  await writeAudit(ctx.db, {
    action: 'webhook.endpoint_updated',
    actor: firmUserActor({ id: ctx.user.id, firmId: ctx.firm.id, label: ctx.user.email }),
    target: uuidTarget({ kind: 'webhook_endpoint', id }),
    context: buildAuditRequestContext({
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId,
    }),
    meta: {
      ...(parsed.url !== undefined ? { url: parsed.url } : {}),
      ...(parsed.events !== undefined ? { events: parsed.events } : {}),
      ...(parsed.active !== undefined ? { active: parsed.active } : {}),
    },
    ts: ctx.now,
  });

  return { status: 'updated', summary: endpointToSummary(updated) };
}

export async function handleDashboardDeleteWebhook(
  ctx: DashboardContext,
  id: string,
): Promise<DashboardWebhookMutationResult> {
  const deleted = await deleteEndpoint(ctx.db, ctx.firm.id, id);
  if (!deleted) return { status: 'not_found' };

  await writeAudit(ctx.db, {
    action: 'webhook.endpoint_deleted',
    actor: firmUserActor({ id: ctx.user.id, firmId: ctx.firm.id, label: ctx.user.email }),
    target: uuidTarget({ kind: 'webhook_endpoint', id }),
    context: buildAuditRequestContext({
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId,
    }),
    meta: {},
    ts: ctx.now,
  });

  return { status: 'deleted' };
}
