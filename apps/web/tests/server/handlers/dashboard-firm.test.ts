/**
 * Tests for dashboard firm profile handlers.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  FirmProfileDeps,
  FirmProfileRow,
  FirmSettingsRow,
} from '@/server/handlers/dashboard-firm';
import { handleGetFirmProfile, handleUpdateFirmProfile } from '@/server/handlers/dashboard-firm';

import { FIXTURE_FIRM_ID, FIXTURE_NOW, buildDashboardCtx } from './dashboard-helpers';

function buildFirmRow(overrides: Partial<FirmProfileRow> = {}): FirmProfileRow {
  return {
    id: FIXTURE_FIRM_ID,
    name: 'Test Firm Ltd',
    slug: 'test-firm',
    tier: 'starter',
    contactEmail: 'contact@test-firm.com',
    countryCode: 'TR',
    billingEmail: 'billing@test-firm.com',
    supportUrl: 'https://support.test-firm.com',
    createdAt: FIXTURE_NOW,
    ...overrides,
  };
}

function buildSettingsRow(overrides: Partial<FirmSettingsRow> = {}): FirmSettingsRow {
  return {
    totpRequired: false,
    dataRetentionDays: 2555,
    ipAllowlist: null,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<FirmProfileDeps> = {}): FirmProfileDeps {
  return {
    findFirmProfile: vi.fn().mockResolvedValue(buildFirmRow()),
    findFirmSettings: vi.fn().mockResolvedValue(buildSettingsRow()),
    updateFirm: vi.fn().mockResolvedValue(buildFirmRow()),
    ...overrides,
  };
}

describe('handleGetFirmProfile', () => {
  it('returns firm profile and settings', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handleGetFirmProfile(deps, ctx);

    expect(result.firm.id).toBe(FIXTURE_FIRM_ID);
    expect(result.firm.name).toBe('Test Firm Ltd');
    expect(result.settings).not.toBeNull();
    expect(result.settings?.dataRetentionDays).toBe(2555);
  });

  it('returns null settings when not found', async () => {
    const deps = buildDeps({
      findFirmSettings: vi.fn().mockResolvedValue(null),
    });
    const ctx = buildDashboardCtx();
    const result = await handleGetFirmProfile(deps, ctx);

    expect(result.firm.id).toBe(FIXTURE_FIRM_ID);
    expect(result.settings).toBeNull();
  });

  it('throws when firm not found', async () => {
    const deps = buildDeps({
      findFirmProfile: vi.fn().mockResolvedValue(null),
    });
    const ctx = buildDashboardCtx();

    await expect(handleGetFirmProfile(deps, ctx)).rejects.toThrow('Firm not found');
  });
});

describe('handleUpdateFirmProfile', () => {
  it('delegates to updateFirm with input', async () => {
    const updatedRow = buildFirmRow({ name: 'Updated Name' });
    const deps = buildDeps({
      updateFirm: vi.fn().mockResolvedValue(updatedRow),
    });
    const ctx = buildDashboardCtx();
    const result = await handleUpdateFirmProfile(deps, ctx, { name: 'Updated Name' });

    expect(result.name).toBe('Updated Name');
    expect(deps.updateFirm).toHaveBeenCalledWith(ctx, { name: 'Updated Name' });
  });

  it('passes partial updates', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    await handleUpdateFirmProfile(deps, ctx, { contactEmail: 'new@firm.com' });

    expect(deps.updateFirm).toHaveBeenCalledWith(ctx, { contactEmail: 'new@firm.com' });
  });
});
