/**
 * Admin firms handler tests — list, get, create, update, soft-delete, restore.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AdminFirmsDeps } from '@/server/handlers/admin-firms';
import {
  handleCreateFirm,
  handleGetFirm,
  handleListFirms,
  handleRestoreFirm,
  handleSoftDeleteFirm,
  handleUpdateFirm,
} from '@/server/handlers/admin-firms';
import type { AdminFirmListItem, FirmCreationWithOwnerResult } from '@/server/repositories/admin';

import { FIXTURE_NOW, buildAdminCtx } from './admin-helpers';

// The create-firm handler writes audit rows and enqueues a welcome
// email after the TX commits. Both side-effects touch the DB through
// their own codepaths and would trip our `{ _tag: 'mock-db' }` stub,
// so we mock them at the module boundary — the handler only needs to
// call them, not do anything with their return values.
vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/email', () => ({
  enqueueEmailFromRoute: vi.fn().mockResolvedValue(undefined),
}));

/* ---------- Fixture builders ---------- */

const FIXTURE_FIRM_ID = 'f2222222-2222-4222-8222-222222222222';
const FIXTURE_FIRM_USER_ID = 'f3222222-2222-4222-8222-222222222222';

function buildFirmItem(overrides: Partial<AdminFirmListItem> = {}): AdminFirmListItem {
  return {
    id: FIXTURE_FIRM_ID,
    name: 'Acme Corp',
    slug: 'acme-corp',
    tier: 'starter',
    contactEmail: 'admin@acme.com',
    countryCode: 'US',
    createdAt: FIXTURE_NOW,
    deletedAt: null,
    ...overrides,
  };
}

function buildCreationResult(
  overrides: Partial<FirmCreationWithOwnerResult> = {},
): FirmCreationWithOwnerResult {
  return {
    firmId: FIXTURE_FIRM_ID,
    firmUserId: FIXTURE_FIRM_USER_ID,
    inviteToken: 'fake-invite-token',
    expiresAt: new Date(FIXTURE_NOW.getTime() + 72 * 60 * 60 * 1000),
    ...overrides,
  };
}

function buildDeps(overrides: Partial<AdminFirmsDeps> = {}): AdminFirmsDeps {
  return {
    listFirms: vi.fn().mockResolvedValue({ firms: [buildFirmItem()], total: 1 }),
    getFirm: vi.fn().mockResolvedValue(buildFirmItem()),
    createFirm: vi.fn().mockResolvedValue(buildCreationResult()),
    updateFirm: vi.fn().mockResolvedValue(buildFirmItem({ tier: 'pro' })),
    softDeleteFirm: vi.fn().mockResolvedValue(undefined),
    restoreFirm: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/* ---------- Tests ---------- */

describe('handleListFirms', () => {
  it('returns firms list and total', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const result = await handleListFirms(deps, ctx, {});

    expect(result.firms).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.firms[0]?.name).toBe('Acme Corp');
  });

  it('passes filters through to deps', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    await handleListFirms(deps, ctx, {
      includeDeleted: true,
      tier: 'enterprise',
      limit: 10,
      offset: 20,
    });

    expect(deps.listFirms).toHaveBeenCalledWith(ctx.db, {
      includeDeleted: true,
      tier: 'enterprise',
      limit: 10,
      offset: 20,
    });
  });
});

describe('handleGetFirm', () => {
  it('returns firm by ID', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const result = await handleGetFirm(deps, ctx, FIXTURE_FIRM_ID);

    expect(result?.id).toBe(FIXTURE_FIRM_ID);
    expect(deps.getFirm).toHaveBeenCalledWith(ctx.db, FIXTURE_FIRM_ID);
  });

  it('returns null when firm not found', async () => {
    const deps = buildDeps({ getFirm: vi.fn().mockResolvedValue(null) });
    const ctx = buildAdminCtx();
    const result = await handleGetFirm(deps, ctx, 'nonexistent');

    expect(result).toBeNull();
  });
});

describe('handleCreateFirm', () => {
  it('creates a firm, forwards admin metadata, and returns the invite result', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const input = {
      name: 'New Firm',
      slug: 'new-firm',
      tier: 'free',
      contactEmail: 'hello@new.com',
      ownerEmail: 'owner@new.com',
    };

    const result = await handleCreateFirm(deps, ctx, input);

    expect(result.id).toBe(FIXTURE_FIRM_ID);
    expect(result.firmUserId).toBe(FIXTURE_FIRM_USER_ID);
    // The handler augments the caller's input with the acting admin's
    // id and the fixture clock so the repository has everything it
    // needs to emit a single atomic creation TX.
    expect(deps.createFirm).toHaveBeenCalledWith(ctx.db, {
      ...input,
      invitedByAdminId: ctx.user.id,
      now: ctx.now,
    });
  });

  it('passes countryCode through to the repository when provided', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const input = {
      name: 'Turkish Firm',
      slug: 'turkish-firm',
      tier: 'starter',
      contactEmail: 'info@tr.com',
      countryCode: 'TR',
      ownerEmail: 'owner@tr.com',
    };

    await handleCreateFirm(deps, ctx, input);
    expect(deps.createFirm).toHaveBeenCalledWith(ctx.db, {
      ...input,
      invitedByAdminId: ctx.user.id,
      now: ctx.now,
    });
  });
});

describe('handleUpdateFirm', () => {
  it('updates firm and returns updated row', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const result = await handleUpdateFirm(deps, ctx, FIXTURE_FIRM_ID, { tier: 'pro' });

    expect(result?.tier).toBe('pro');
    expect(deps.updateFirm).toHaveBeenCalledWith(ctx.db, FIXTURE_FIRM_ID, { tier: 'pro' });
  });

  it('returns null when firm not found for update', async () => {
    const deps = buildDeps({ updateFirm: vi.fn().mockResolvedValue(null) });
    const ctx = buildAdminCtx();
    const result = await handleUpdateFirm(deps, ctx, 'nonexistent', { tier: 'pro' });

    expect(result).toBeNull();
  });
});

describe('handleSoftDeleteFirm', () => {
  it('calls softDeleteFirm with db, firmId, and now', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    await handleSoftDeleteFirm(deps, ctx, FIXTURE_FIRM_ID);

    expect(deps.softDeleteFirm).toHaveBeenCalledWith(ctx.db, FIXTURE_FIRM_ID, ctx.now);
  });
});

describe('handleRestoreFirm', () => {
  it('calls restoreFirm with db and firmId', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    await handleRestoreFirm(deps, ctx, FIXTURE_FIRM_ID);

    expect(deps.restoreFirm).toHaveBeenCalledWith(ctx.db, FIXTURE_FIRM_ID);
  });
});
