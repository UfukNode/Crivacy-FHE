/**
 * Tests for outbound webhook envelope builder.
 */

import { describe, expect, it } from 'vitest';

import { WebhookError, buildEnvelope, serializeEnvelope } from '@/lib/webhook';

import { FIXTURE_DELIVERY_ID, FIXTURE_NOW } from './fixtures';

describe('buildEnvelope', () => {
  it('builds a valid envelope', () => {
    const envelope = buildEnvelope({
      deliveryId: FIXTURE_DELIVERY_ID,
      eventType: 'credential.created',
      eventCreatedAt: FIXTURE_NOW,
      payload: { contractId: 'cid-001' },
      sourceSessionId: 'sess-001',
    });

    expect(envelope.id).toBe(FIXTURE_DELIVERY_ID);
    expect(envelope.type).toBe('credential.created');
    expect(envelope.createdAt).toBe(FIXTURE_NOW.toISOString());
    // `firmId` is intentionally not part of the outbound envelope;
    // receiving firms authenticate via their signing secret and
    // know their own identity without needing it echoed back.
    expect(envelope).not.toHaveProperty('firmId');
    expect(envelope.data).toEqual({ contractId: 'cid-001' });
    expect(envelope.sessionId).toBe('sess-001');
  });

  it('handles null sessionId', () => {
    const envelope = buildEnvelope({
      deliveryId: FIXTURE_DELIVERY_ID,
      eventType: 'credential.revoked',
      eventCreatedAt: FIXTURE_NOW,
      payload: {},
      sourceSessionId: null,
    });

    expect(envelope.sessionId).toBeNull();
  });

  it('returns frozen envelope', () => {
    const envelope = buildEnvelope({
      deliveryId: FIXTURE_DELIVERY_ID,
      eventType: 'credential.created',
      eventCreatedAt: FIXTURE_NOW,
      payload: {},
      sourceSessionId: null,
    });

    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it('throws on empty deliveryId', () => {
    expect(() =>
      buildEnvelope({
        deliveryId: '',
        eventType: 'credential.created',
        eventCreatedAt: FIXTURE_NOW,
        payload: {},
        sourceSessionId: null,
      }),
    ).toThrow(WebhookError);
  });

  it('throws on empty eventType', () => {
    expect(() =>
      buildEnvelope({
        deliveryId: FIXTURE_DELIVERY_ID,
        eventType: '',
        eventCreatedAt: FIXTURE_NOW,
        payload: {},
        sourceSessionId: null,
      }),
    ).toThrow(WebhookError);
  });
});

describe('serializeEnvelope', () => {
  it('produces valid JSON', () => {
    const envelope = buildEnvelope({
      deliveryId: FIXTURE_DELIVERY_ID,
      eventType: 'credential.created',
      eventCreatedAt: FIXTURE_NOW,
      payload: { key: 'value' },
      sourceSessionId: null,
    });

    const json = serializeEnvelope(envelope);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['id']).toBe(FIXTURE_DELIVERY_ID);
    expect(parsed['type']).toBe('credential.created');
    expect(parsed['data']).toEqual({ key: 'value' });
    expect(parsed).not.toHaveProperty('firmId');
  });
});
