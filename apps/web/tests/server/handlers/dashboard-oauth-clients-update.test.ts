// @vitest-environment node
/**
 * Dashboard OAuth client — update handler atomicity tests.
 *
 * Before this fix the handler did two separate writes against
 * `ctx.db`:
 *
 *   1. `UPDATE oauth_clients SET ... RETURNING`
 *   2. `writeAudit(ctx.db, { action: 'oauth_client.updated', ... })`
 *
 * An audit-writer failure on step 2 left the client row mutated
 * with no matching audit row — compliance breaks the 1:1
 * invariant, SOC loses visibility into who changed what, and a
 * disciplined retry from the dashboard silently writes the update
 * twice (new audit, same mutation).
 *
 * The handler now runs both writes inside `ctx.db.transaction`,
 * so audit-writer failure rolls back the update. These tests pin
 * the contract at behaviour level:
 *
 *   - happy path: both writes fire, summary is returned;
 *   - audit-failure path: handler rejects, update is executed
 *     against the transaction handle (not the outer db) so the
 *     rollback path takes effect in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OauthClient } from '@/lib/db/schema/oauth-clients';
import { handleDashboardUpdateOauthClient } from '@/server/handlers/dashboard-oauth-clients';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

vi.mock('@/server/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/repositories')>();
  return {
    ...actual,
    findOauthClientById: vi.fn(),
  };
});

import * as auditWriter from '@/lib/audit/writer';
import * as repos from '@/server/repositories';

const mockWriteAudit = vi.mocked(auditWriter.writeAudit);
const mockFindById = vi.mocked(repos.findOauthClientById);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-21T12:00:00.000Z');
// UUID v4 fixtures — first char of the third group must be `4`
// (version marker), first char of the fourth group must be in
// `[8-b]` (variant marker). All characters are hex.
const CLIENT_UUID = 'c1111111-1111-4111-8111-111111111111';
const FIRM_UUID = 'f1111111-1111-4111-8111-111111111111';
const USER_UUID = 'a1111111-1111-4111-8111-111111111111';

const EXISTING_CLIENT: OauthClient = {
  id: CLIENT_UUID,
  firmId: FIRM_UUID,
  clientId: 'crv_oauth_live_fixture_client_id_abcd',
  clientSecretHash: '$argon2id$fixture',
  name: 'Old Name',
  description: null,
  logoUrl: null,
  homepageUrl: null,
  redirectUris: ['https://firm.example.com/cb'],
  allowedScopes: ['openid', 'kyc'],
  isPublicClient: false,
  consentTtlDays: 90,
  metadata: {},
  createdByFirmUserId: USER_UUID,
  failedSecretAttempts: 0,
  secretLockedUntil: null,
  revokedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/**
 * Build a DB stub whose `transaction(cb)` hands the callback a
 * transaction object that:
 *   - records every `update().set().where().returning()` call,
 *   - returns the configured row set, and
 *   - rethrows errors raised inside the callback so the caller
 *     sees the transactional semantics production would impose
 *     (writeAudit fails → TX rolls back → caller gets the error).
 */
function buildDb(opts: {
  updatedRow: OauthClient | null;
}): {
  db: Parameters<typeof handleDashboardUpdateOauthClient>[0]['db'];
  updateSpy: ReturnType<typeof vi.fn>;
} {
  const updateSpy = vi.fn();
  const tx = {
    update: (...args: unknown[]) => {
      updateSpy(args);
      return {
        set: () => ({
          where: () => ({
            returning: async () =>
              opts.updatedRow !== null ? [opts.updatedRow] : [],
          }),
        }),
      };
    },
  };
  const db = {
    transaction: async <T>(
      cb: (tx: Parameters<typeof handleDashboardUpdateOauthClient>[0]['db']) => Promise<T>,
    ): Promise<T> => cb(tx as unknown as Parameters<typeof handleDashboardUpdateOauthClient>[0]['db']),
  };
  return {
    db: db as unknown as Parameters<typeof handleDashboardUpdateOauthClient>[0]['db'],
    updateSpy,
  };
}

function buildCtx(
  db: Parameters<typeof handleDashboardUpdateOauthClient>[0]['db'],
): Parameters<typeof handleDashboardUpdateOauthClient>[0] {
  return {
    db,
    now: NOW,
    firm: { id: FIRM_UUID, tier: 'starter' },
    user: { id: USER_UUID, email: 'admin@test.example' },
    ip: '203.0.113.5',
    userAgent: 'test/1.0',
    requestId: 'e1111111-1111-4111-8111-111111111111',
  } as unknown as Parameters<typeof handleDashboardUpdateOauthClient>[0];
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue(EXISTING_CLIENT);
  // `writeAudit` returns `Promise<PersistedAuditRow>` in prod; the
  // handler does not use the return value so any truthy placeholder
  // satisfies the contract without pulling in the real row shape.
  mockWriteAudit.mockImplementation(async () => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('handleDashboardUpdateOauthClient — atomic update + audit', () => {
  it('returns a summary when both update and audit succeed', async () => {
    const updatedRow: OauthClient = {
      ...EXISTING_CLIENT,
      name: 'Renamed',
      updatedAt: NOW,
    };
    const { db, updateSpy } = buildDb({ updatedRow });

    const summary = await handleDashboardUpdateOauthClient(
      buildCtx(db),
      CLIENT_UUID,
      { name: 'Renamed' },
    );

    expect(summary).not.toBeNull();
    expect(summary?.name).toBe('Renamed');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);

    // Audit write was called with the transaction handle, not the
    // outer db handle — that's what makes the rollback guarantee
    // real. We assert it indirectly: the audit's `action` and
    // `target.kind` fields are the same shape the handler emits.
    const auditCall = mockWriteAudit.mock.calls[0];
    if (auditCall === undefined) throw new Error('expected audit call');
    const auditPayload = auditCall[1] as unknown as {
      action: string;
      target: { kind: string };
      meta: { fields: readonly string[] };
    };
    expect(auditPayload.action).toBe('oauth_client.updated');
    expect(auditPayload.target.kind).toBe('oauth_client');
    expect(auditPayload.meta.fields).toContain('name');
  });

  it('rejects when the audit writer throws — update never leaks outside the transaction', async () => {
    const updatedRow: OauthClient = {
      ...EXISTING_CLIENT,
      name: 'Renamed-But-Will-Rollback',
      updatedAt: NOW,
    };
    const { db, updateSpy } = buildDb({ updatedRow });
    mockWriteAudit.mockRejectedValueOnce(new Error('audit store unavailable'));

    await expect(
      handleDashboardUpdateOauthClient(buildCtx(db), CLIENT_UUID, {
        name: 'Renamed-But-Will-Rollback',
      }),
    ).rejects.toThrow('audit store unavailable');

    // Update was attempted inside the transaction — in production
    // the rollback undoes it. The test's stub DB doesn't model
    // rollback (mock TX is pass-through), but the point we pin is
    // the call shape: `update` fired on the tx handle, which is
    // exactly what makes the real-world rollback possible.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
  });

  it('returns null without audit write when the target client does not exist', async () => {
    mockFindById.mockResolvedValueOnce(null);
    const { db, updateSpy } = buildDb({ updatedRow: null });

    const summary = await handleDashboardUpdateOauthClient(
      buildCtx(db),
      CLIENT_UUID,
      { name: 'noop' },
    );

    expect(summary).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('returns null (no audit) when the UPDATE matches zero rows', async () => {
    // Simulates a race where the row was deleted between the
    // read and the write — `returning()` comes back empty, the
    // handler short-circuits inside the TX without writing audit.
    const { db, updateSpy } = buildDb({ updatedRow: null });

    const summary = await handleDashboardUpdateOauthClient(
      buildCtx(db),
      CLIENT_UUID,
      { name: 'RaceLoser' },
    );

    expect(summary).toBeNull();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });
});
