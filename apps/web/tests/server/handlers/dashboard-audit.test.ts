/**
 * Tests for dashboard audit log handler.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  AuditListItem,
  AuditListResult,
  AuditLogDeps,
} from '@/server/handlers/dashboard-audit';
import { handleListAuditEntries } from '@/server/handlers/dashboard-audit';

import { FIXTURE_NOW, buildDashboardCtx } from './dashboard-helpers';

function buildAuditItem(overrides: Partial<AuditListItem> = {}): AuditListItem {
  return {
    id: 1,
    action: 'api_key.created',
    actorKind: 'firm_user',
    actorId: 'u1111111-1111-4111-8111-111111111111',
    actorLabel: 'user@test-firm.com',
    targetKind: 'api_key',
    targetId: 'ak111111-1111-4111-8111-111111111111',
    targetRef: null,
    ip: null,
    userAgent: null,
    requestId: null,
    meta: { keyName: 'Production Key' },
    ts: FIXTURE_NOW,
    ...overrides,
  };
}

function buildListResult(overrides: Partial<AuditListResult> = {}): AuditListResult {
  return {
    entries: [buildAuditItem()],
    hasMore: false,
    nextCursor: null,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<AuditLogDeps> = {}): AuditLogDeps {
  return {
    listAuditEntries: vi.fn().mockResolvedValue(buildListResult()),
    ...overrides,
  };
}

describe('handleListAuditEntries', () => {
  it('returns audit entries with defaults', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    const result = await handleListAuditEntries(deps, ctx, {});

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.action).toBe('api_key.created');
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('passes action filter', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    await handleListAuditEntries(deps, ctx, { action: 'credential.created' });

    expect(deps.listAuditEntries).toHaveBeenCalledWith(ctx, { action: 'credential.created' });
  });

  it('passes limit and cursor', async () => {
    const deps = buildDeps();
    const ctx = buildDashboardCtx();
    await handleListAuditEntries(deps, ctx, { limit: 25, cursor: 'xyz' });

    expect(deps.listAuditEntries).toHaveBeenCalledWith(ctx, { limit: 25, cursor: 'xyz' });
  });

  it('returns paginated results with hasMore and nextCursor', async () => {
    const deps = buildDeps({
      listAuditEntries: vi.fn().mockResolvedValue(
        buildListResult({
          entries: [buildAuditItem(), buildAuditItem({ id: 2, action: 'credential.verified' })],
          hasMore: true,
          nextCursor: 'cursor-page-2',
        }),
      ),
    });
    const ctx = buildDashboardCtx();
    const result = await handleListAuditEntries(deps, ctx, {});

    expect(result.entries).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('cursor-page-2');
  });

  it('returns entries with null meta', async () => {
    const deps = buildDeps({
      listAuditEntries: vi.fn().mockResolvedValue(
        buildListResult({
          entries: [buildAuditItem({ meta: null })],
        }),
      ),
    });
    const ctx = buildDashboardCtx();
    const result = await handleListAuditEntries(deps, ctx, {});

    expect(result.entries[0]?.meta).toBeNull();
  });
});
