/**
 * Tests for dashboard webhook delivery handlers.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  DeliveryListItem,
  DeliveryListResult,
  WebhookDeliveryDeps,
} from '@/server/handlers/dashboard-webhooks';
import { handleListDeliveries, handleReplayDelivery } from '@/server/handlers/dashboard-webhooks';

import { FIXTURE_NOW, buildDashboardCtx } from './dashboard-helpers';

const FIXTURE_DELIVERY_ID = 'd1111111-1111-4111-8111-111111111111';
const FIXTURE_ENDPOINT_ID = 'e1111111-1111-4111-8111-111111111111';
const FIXTURE_EVENT_ID = 'ev111111-1111-4111-8111-111111111111';

function buildDeliveryItem(overrides: Partial<DeliveryListItem> = {}): DeliveryListItem {
  return {
    id: FIXTURE_DELIVERY_ID,
    endpointId: FIXTURE_ENDPOINT_ID,
    eventId: FIXTURE_EVENT_ID,
    eventType: 'credential.created',
    status: 'delivered',
    attempts: 1,
    maxAttempts: 7,
    httpStatus: 200,
    error: null,
    createdAt: FIXTURE_NOW,
    deliveredAt: FIXTURE_NOW,
    nextRetryAt: null,
    ...overrides,
  };
}

function buildListResult(overrides: Partial<DeliveryListResult> = {}): DeliveryListResult {
  return {
    deliveries: [buildDeliveryItem()],
    total: 1,
    hasMore: false,
    cursor: null,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<WebhookDeliveryDeps> = {}): WebhookDeliveryDeps {
  return {
    listDeliveries: vi.fn().mockResolvedValue(buildListResult()),
    replayDelivery: vi.fn().mockResolvedValue({ id: FIXTURE_DELIVERY_ID }),
    ...overrides,
  };
}

describe('handleListDeliveries', () => {
  it('returns delivery list with defaults', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handleListDeliveries(deps, ctx, {});

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]?.id).toBe(FIXTURE_DELIVERY_ID);
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it('passes filter options through', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    await handleListDeliveries(deps, ctx, {
      endpointId: FIXTURE_ENDPOINT_ID,
      status: 'failed',
      limit: 10,
      cursor: 'abc123',
    });

    expect(deps.listDeliveries).toHaveBeenCalledWith(ctx, {
      endpointId: FIXTURE_ENDPOINT_ID,
      status: 'failed',
      limit: 10,
      cursor: 'abc123',
    });
  });

  it('returns empty list when no deliveries', async () => {
    const deps = buildDeps({
      listDeliveries: vi.fn().mockResolvedValue(buildListResult({ deliveries: [], total: 0 })),
    });
    const ctx = buildDashboardCtx();
    const result = await handleListDeliveries(deps, ctx, {});

    expect(result.deliveries).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe('handleReplayDelivery', () => {
  it('replays and returns the new delivery id', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handleReplayDelivery(deps, ctx, FIXTURE_DELIVERY_ID);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(FIXTURE_DELIVERY_ID);
    expect(deps.replayDelivery).toHaveBeenCalledWith(ctx, FIXTURE_DELIVERY_ID);
  });

  it('returns null when the delivery is not owned by the firm', async () => {
    const deps = buildDeps({
      replayDelivery: vi.fn().mockResolvedValue(null),
    });
    const ctx = buildDashboardCtx();
    const result = await handleReplayDelivery(deps, ctx, FIXTURE_DELIVERY_ID);

    expect(result).toBeNull();
  });
});
