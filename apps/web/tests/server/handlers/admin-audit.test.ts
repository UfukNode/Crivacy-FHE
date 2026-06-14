/**
 * Admin global audit handler tests.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AdminAuditDeps } from '@/server/handlers/admin-audit';
import { handleListGlobalAudit } from '@/server/handlers/admin-audit';
import type { AdminAuditEntry } from '@/server/repositories/admin';

import { FIXTURE_NOW, buildAdminCtx } from './admin-helpers';

/* ---------- Fixture builders ---------- */

function buildAuditEntry(overrides: Partial<AdminAuditEntry> = {}): AdminAuditEntry {
  return {
    id: 1,
    action: 'firm.created',
    actorKind: 'admin',
    actorId: 'a1111111-1111-4111-8111-111111111111',
    actorLabel: 'admin@crivacy.io',
    firmId: 'f2222222-2222-4222-8222-222222222222',
    targetKind: 'firm',
    targetId: 'f2222222-2222-4222-8222-222222222222',
    targetRef: 'acme-corp',
    meta: null,
    ts: FIXTURE_NOW,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<AdminAuditDeps> = {}): AdminAuditDeps {
  return {
    listGlobalAudit: vi.fn().mockResolvedValue({
      entries: [buildAuditEntry()],
      total: 1,
    }),
    ...overrides,
  };
}

/* ---------- Tests ---------- */

describe('handleListGlobalAudit', () => {
  it('returns audit entries and total', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const result = await handleListGlobalAudit(deps, ctx, {});

    expect(result.entries).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.entries[0]?.action).toBe('firm.created');
  });

  it('passes all filter options through', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const input = {
      firmId: 'f2222222-2222-4222-8222-222222222222',
      action: 'kyc.session.created',
      actorKind: 'api_key',
      limit: 25,
      offset: 50,
    };
    await handleListGlobalAudit(deps, ctx, input);

    expect(deps.listGlobalAudit).toHaveBeenCalledWith(ctx.db, input);
  });

  it('works with no filters (default input)', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    await handleListGlobalAudit(deps, ctx);

    expect(deps.listGlobalAudit).toHaveBeenCalledWith(ctx.db, {});
  });

  it('returns empty array when no entries match', async () => {
    const deps = buildDeps({
      listGlobalAudit: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    });
    const ctx = buildAdminCtx();
    const result = await handleListGlobalAudit(deps, ctx, { action: 'nonexistent' });

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
