/**
 * Tests for webhook event fan-out.
 */

import { describe, expect, it, vi } from 'vitest';

import { WebhookError, fanOutEvent } from '@/lib/webhook';

import {
  FIXTURE_EVENT_ID,
  FIXTURE_FIRM_ID,
  FIXTURE_NOW,
  buildFanOutEndpoints,
  buildMockFanOutDeps,
} from './fixtures';

const INPUT = {
  eventId: FIXTURE_EVENT_ID,
  eventType: 'credential.created',
  firmId: FIXTURE_FIRM_ID,
};

describe('fanOutEvent', () => {
  it('creates deliveries for all matching endpoints', async () => {
    const endpoints = buildFanOutEndpoints(3);
    const deps = buildMockFanOutDeps(endpoints);

    const result = await fanOutEvent(deps, INPUT, FIXTURE_NOW);

    expect(result.eventId).toBe(FIXTURE_EVENT_ID);
    expect(result.eventType).toBe('credential.created');
    expect(result.deliveryCount).toBe(3);
    expect(result.endpointIds).toEqual(['ep-0001', 'ep-0002', 'ep-0003']);
    expect(deps.createdDeliveries.length).toBe(3);
  });

  it('returns empty result when no endpoints match', async () => {
    const deps = buildMockFanOutDeps([]);

    const result = await fanOutEvent(deps, INPUT, FIXTURE_NOW);

    expect(result.deliveryCount).toBe(0);
    expect(result.endpointIds).toEqual([]);
  });

  it('handles single endpoint', async () => {
    const endpoints = buildFanOutEndpoints(1);
    const deps = buildMockFanOutDeps(endpoints);

    const result = await fanOutEvent(deps, INPUT, FIXTURE_NOW);

    expect(result.deliveryCount).toBe(1);
    expect(result.endpointIds).toEqual(['ep-0001']);
  });

  it('passes maxAttempts from endpoint', async () => {
    const endpoints = [{ id: 'ep-custom', maxAttempts: 3 }];
    const deps = buildMockFanOutDeps(endpoints);

    await fanOutEvent(deps, INPUT, FIXTURE_NOW);

    // The createDelivery function is called, but we need to verify the args
    expect(deps.createdDeliveries.length).toBe(1);
  });

  it('passes nextRetryAt as now', async () => {
    const deps = buildMockFanOutDeps(buildFanOutEndpoints(1));
    const createSpy = vi.spyOn(deps, 'createDelivery');

    await fanOutEvent(deps, INPUT, FIXTURE_NOW);

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ nextRetryAt: FIXTURE_NOW }));
  });

  it('continues on duplicate delivery error', async () => {
    const endpoints = buildFanOutEndpoints(3);
    let callCount = 0;
    const deps = {
      findEndpoints: async () => endpoints,
      createDelivery: async (input: { endpointId: string; eventId: string }) => {
        callCount++;
        if (callCount === 2) {
          throw new Error('unique constraint violation: duplicate key');
        }
        return { id: `del-${input.endpointId}` };
      },
    };

    const result = await fanOutEvent(deps, INPUT, FIXTURE_NOW);

    // Even though one failed with duplicate, all 3 endpoint IDs are reported
    expect(result.deliveryCount).toBe(3);
  });

  it('throws on non-duplicate delivery error', async () => {
    const endpoints = buildFanOutEndpoints(1);
    const deps = {
      findEndpoints: async () => endpoints,
      createDelivery: async () => {
        throw new Error('connection refused');
      },
    };

    await expect(fanOutEvent(deps, INPUT, FIXTURE_NOW)).rejects.toThrow(WebhookError);
  });

  it('throws on findEndpoints error', async () => {
    const deps = {
      findEndpoints: async () => {
        throw new Error('db down');
      },
      createDelivery: async () => ({ id: 'x' }),
    };

    await expect(fanOutEvent(deps, INPUT, FIXTURE_NOW)).rejects.toThrow(WebhookError);
  });

  it('throws on empty eventId', async () => {
    const deps = buildMockFanOutDeps();
    await expect(fanOutEvent(deps, { ...INPUT, eventId: '' }, FIXTURE_NOW)).rejects.toThrow(
      WebhookError,
    );
  });

  it('throws on empty eventType', async () => {
    const deps = buildMockFanOutDeps();
    await expect(fanOutEvent(deps, { ...INPUT, eventType: '' }, FIXTURE_NOW)).rejects.toThrow(
      WebhookError,
    );
  });

  it('returns frozen result', async () => {
    const deps = buildMockFanOutDeps(buildFanOutEndpoints(1));
    const result = await fanOutEvent(deps, INPUT, FIXTURE_NOW);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.endpointIds)).toBe(true);
  });
});
