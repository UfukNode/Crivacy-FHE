/**
 * Admin system handler tests — metrics.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AdminSystemDeps, SystemMetrics } from '@/server/handlers/admin-system';
import { handleGetSystemMetrics } from '@/server/handlers/admin-system';

import { buildAdminCtx } from './admin-helpers';

/* ---------- Fixture builders ---------- */

function buildMetrics(overrides: Partial<SystemMetrics> = {}): SystemMetrics {
  return {
    totalFirms: 12,
    activeFirms: 10,
    totalSessions: 500,
    activeSessions: 42,
    totalAuditEntries: 3000,
    totalIncidents: 5,
    activeIncidents: 1,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<AdminSystemDeps> = {}): AdminSystemDeps {
  return {
    getMetrics: vi.fn().mockResolvedValue(buildMetrics()),
    ...overrides,
  };
}

/* ---------- Tests ---------- */

describe('handleGetSystemMetrics', () => {
  it('returns system metrics from deps', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const result = await handleGetSystemMetrics(deps, ctx);

    expect(result.totalFirms).toBe(12);
    expect(result.activeFirms).toBe(10);
    expect(result.totalSessions).toBe(500);
    expect(result.activeSessions).toBe(42);
    expect(result.totalAuditEntries).toBe(3000);
    expect(result.totalIncidents).toBe(5);
    expect(result.activeIncidents).toBe(1);
    expect(deps.getMetrics).toHaveBeenCalledWith(ctx.db);
  });

  it('passes zero values through', async () => {
    const deps = buildDeps({
      getMetrics: vi.fn().mockResolvedValue(
        buildMetrics({
          totalFirms: 0,
          activeFirms: 0,
          totalSessions: 0,
          activeSessions: 0,
          totalAuditEntries: 0,
          totalIncidents: 0,
          activeIncidents: 0,
        }),
      ),
    });
    const ctx = buildAdminCtx();
    const result = await handleGetSystemMetrics(deps, ctx);

    expect(result.totalFirms).toBe(0);
    expect(result.activeIncidents).toBe(0);
  });
});
