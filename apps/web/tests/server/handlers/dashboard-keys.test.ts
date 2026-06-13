/**
 * Tests for dashboard API key management handlers.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_TIER_LIMITS } from '@/lib/ratelimit/tiers';
import type { ApiKeyDeps, ApiKeyListItem } from '@/server/handlers/dashboard-keys';
import {
  handleCreateApiKey,
  handleDeleteApiKey,
  handleListApiKeys,
  handleRotateApiKey,
} from '@/server/handlers/dashboard-keys';

import { FIXTURE_FIRM_ID, FIXTURE_NOW, buildDashboardCtx } from './dashboard-helpers';

const FIXTURE_KEY_ID = 'ak111111-1111-4111-8111-111111111111';

function buildKeyItem(overrides: Partial<ApiKeyListItem> = {}): ApiKeyListItem {
  return {
    id: FIXTURE_KEY_ID,
    name: 'My API Key',
    prefix: 'crv_live_abcd1234',
    mode: 'live',
    scopes: ['kyc:create', 'kyc:read'],
    createdAt: FIXTURE_NOW,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<ApiKeyDeps> = {}): ApiKeyDeps {
  return {
    authConfig: { apiKeyBcryptCost: 4 },
    listKeys: vi.fn().mockResolvedValue([buildKeyItem()]),
    countActiveKeys: vi.fn().mockResolvedValue(0),
    insertKey: vi.fn().mockResolvedValue({ id: FIXTURE_KEY_ID, createdAt: FIXTURE_NOW }),
    revokeKey: vi.fn().mockResolvedValue(true),
    rotateKey: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('handleListApiKeys', () => {
  it('returns list of keys', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handleListApiKeys(deps, ctx);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(FIXTURE_KEY_ID);
    expect(deps.listKeys).toHaveBeenCalledWith(ctx);
  });

  it('returns empty list when no keys', async () => {
    const deps = buildDeps({ listKeys: vi.fn().mockResolvedValue([]) });
    const ctx = buildDashboardCtx();
    const result = await handleListApiKeys(deps, ctx);

    expect(result).toHaveLength(0);
  });
});

describe('handleCreateApiKey', () => {
  it('generates key, hashes, inserts, and returns result with rawKey', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    const outcome = await handleCreateApiKey(deps, ctx, {
      name: 'New Key',
      mode: 'live',
      scopes: ['kyc:create'],
    });

    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') throw new Error('expected created outcome');
    expect(outcome.key.name).toBe('New Key');
    expect(outcome.key.mode).toBe('live');
    expect(outcome.key.scopes).toEqual(['kyc:create']);
    expect(outcome.key.rawKey).toMatch(/^crv_live_/);
    expect(outcome.key.prefix).toMatch(/^crv_live_/);
    expect(outcome.key.id).toBe(FIXTURE_KEY_ID);

    expect(deps.insertKey).toHaveBeenCalledWith(
      ctx.db,
      FIXTURE_FIRM_ID,
      expect.objectContaining({
        name: 'New Key',
        mode: 'live',
        scopes: ['kyc:create'],
      }),
    );
  });

  it('passes expiresAt when provided', async () => {
    const expiresAt = new Date('2027-01-01');
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    const outcome = await handleCreateApiKey(deps, ctx, {
      name: 'Expiring Key',
      mode: 'test',
      scopes: ['kyc:read'],
      expiresAt,
    });

    if (outcome.status !== 'created') throw new Error('expected created outcome');
    expect(outcome.key.expiresAt).toEqual(expiresAt);
  });

  it('defaults expiresAt to null', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    const outcome = await handleCreateApiKey(deps, ctx, {
      name: 'No Expiry',
      mode: 'live',
      scopes: ['kyc:read'],
    });

    if (outcome.status !== 'created') throw new Error('expected created outcome');
    expect(outcome.key.expiresAt).toBeNull();
  });

  it('returns tier_exceeded when active key count is at the tier cap', async () => {
    // Dashboard fixture defaults to 'starter' tier — use its published cap
    // rather than a magic number so the test stays honest if pricing shifts.
    const starterCap = DEFAULT_TIER_LIMITS.starter.apiKeys;
    if (starterCap === null) throw new Error('starter.apiKeys must be finite for this test');
    const deps = buildDeps({ countActiveKeys: vi.fn().mockResolvedValue(starterCap) });
    const ctx = buildDashboardCtx();
    const outcome = await handleCreateApiKey(deps, ctx, {
      name: 'Over Cap',
      mode: 'live',
      scopes: ['kyc:read'],
    });

    expect(outcome.status).toBe('tier_exceeded');
    if (outcome.status !== 'tier_exceeded') throw new Error('expected tier_exceeded');
    expect(outcome.maxSlots).toBe(starterCap);
    expect(deps.insertKey).not.toHaveBeenCalled();
  });
});

describe('handleDeleteApiKey', () => {
  it('calls revokeKey with correct params', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    await handleDeleteApiKey(deps, ctx, FIXTURE_KEY_ID);

    expect(deps.revokeKey).toHaveBeenCalledWith(
      ctx.db,
      FIXTURE_FIRM_ID,
      FIXTURE_KEY_ID,
      expect.any(Date),
    );
  });
});

describe('handleRotateApiKey', () => {
  it('generates new key, hashes, and calls rotateKey', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handleRotateApiKey(deps, ctx, FIXTURE_KEY_ID);

    expect(result).not.toBeNull();
    expect(result!.rawKey).toMatch(/^crv_live_/);
    expect(result!.prefix).toMatch(/^crv_live_/);
    expect(deps.rotateKey).toHaveBeenCalledWith(
      ctx.db,
      FIXTURE_FIRM_ID,
      FIXTURE_KEY_ID,
      expect.stringMatching(/^crv_live_/),
      expect.any(String), // bcrypt hash
      expect.any(Date),
    );
  });
});
