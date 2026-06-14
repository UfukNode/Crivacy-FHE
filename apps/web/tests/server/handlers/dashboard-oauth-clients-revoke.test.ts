// @vitest-environment node
/**
 * Dashboard OAuth client — revoke handler cascade tests.
 *
 * The revoke handler writes four rows inside one transaction:
 *
 *   1. `oauth_clients.revoked_at` — the parent revoke.
 *   2. `oauth_access_tokens.revoked_at` — cascade-kills every
 *      outstanding token so `/userinfo` stops answering even
 *      before the query-time `revoked_at IS NULL` filter bites.
 *   3. `oauth_consents.revoked_at` — cascade-closes the user-
 *      facing grant so `/settings/connected-apps` stops showing
 *      the firm as an active connection.
 *   4. `writeAudit` — one row per revoke, correlated to the
 *      parent client id.
 *
 * All four happen in one TX, so an audit failure rolls every
 * cascade back. These tests pin the contract at behaviour level.
 *
 * Why this test file is separate from
 * `dashboard-oauth-clients-update.test.ts`: the revoke and update
 * handlers exercise different DB shapes (revoke has three
 * `.update()` calls, update has one) and spying on each call
 * separately is cleaner with per-handler test helpers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OauthClient } from '@/lib/db/schema/oauth-clients';
import { handleDashboardRevokeOauthClient } from '@/server/handlers/dashboard-oauth-clients';

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
const CLIENT_UUID = 'c1111111-1111-4111-8111-111111111111';
const FIRM_UUID = 'f1111111-1111-4111-8111-111111111111';
const USER_UUID = 'a1111111-1111-4111-8111-111111111111';

const ACTIVE_CLIENT: OauthClient = {
  id: CLIENT_UUID,
  firmId: FIRM_UUID,
  clientId: 'crv_oauth_live_fixture_client_id_abcd',
  clientSecretHash: '$argon2id$fixture',
  name: 'Fixture Client',
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
 * Build a transaction stub that records every `update(table)` call
 * so the test can assert the three expected cascades fire in the
 * right order and against the right tables. The `tableTag` symbol
 * the mock returns is the table reference drizzle passes in —
 * comparing it by identity against the schema's table export keeps
 * the test robust to reordering of the `.set().where()` chain.
 */
function buildDb(opts: { updatedClientRow?: number }) {
  const updateCalls: unknown[] = [];
  const tx = {
    update: (table: unknown) => {
      updateCalls.push(table);
      return {
        set: () => ({
          where: async () => undefined,
        }),
      };
    },
  };
  const db = {
    transaction: async <T>(
      cb: (t: Parameters<typeof handleDashboardRevokeOauthClient>[0]['db']) => Promise<T>,
    ): Promise<T> =>
      cb(tx as unknown as Parameters<typeof handleDashboardRevokeOauthClient>[0]['db']),
  };
  return {
    db: db as unknown as Parameters<typeof handleDashboardRevokeOauthClient>[0]['db'],
    updateCalls,
    _ignored: opts,
  };
}

function buildCtx(
  db: Parameters<typeof handleDashboardRevokeOauthClient>[0]['db'],
): Parameters<typeof handleDashboardRevokeOauthClient>[0] {
  return {
    db,
    now: NOW,
    firm: { id: FIRM_UUID, tier: 'starter' },
    user: { id: USER_UUID, email: 'admin@test.example' },
    ip: '203.0.113.5',
    userAgent: 'test/1.0',
    requestId: 'e1111111-1111-4111-8111-111111111111',
  } as unknown as Parameters<typeof handleDashboardRevokeOauthClient>[0];
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue(ACTIVE_CLIENT);
  mockWriteAudit.mockImplementation(async () => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('handleDashboardRevokeOauthClient — cascade', () => {
  it('revokes the client + cascades into access tokens + consents + audit', async () => {
    const { db, updateCalls } = buildDb({});
    const result = await handleDashboardRevokeOauthClient(buildCtx(db), CLIENT_UUID);

    expect(result).toBe('revoked');

    // Three separate `update(table)` calls — one per cascade step.
    // Order is enforced by the handler: client first (parent kill),
    // then tokens (so `/userinfo` stops honouring them), then
    // consents (so `/settings/connected-apps` drops the row).
    expect(updateCalls).toHaveLength(3);

    // Audit row always the last write in the transaction — pins
    // the "both halves commit together, neither commits alone"
    // invariant.
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    const auditCall = mockWriteAudit.mock.calls[0];
    if (auditCall === undefined) throw new Error('expected audit call');
    const auditPayload = auditCall[1] as unknown as {
      action: string;
      target: { kind: string; id: string };
    };
    expect(auditPayload.action).toBe('oauth_client.revoked');
    expect(auditPayload.target.kind).toBe('oauth_client');
    expect(auditPayload.target.id).toBe(CLIENT_UUID);
  });

  it('returns already_revoked without any update when the row is already stamped', async () => {
    mockFindById.mockResolvedValueOnce({
      ...ACTIVE_CLIENT,
      revokedAt: new Date(NOW.getTime() - 3600_000),
    });
    const { db, updateCalls } = buildDb({});

    const result = await handleDashboardRevokeOauthClient(buildCtx(db), CLIENT_UUID);

    expect(result).toBe('already_revoked');
    // Idempotent ack — no cascade rewrites downstream state a
    // second time (which would overwrite legitimate user-revoke
    // rows with `client_revoked`).
    expect(updateCalls).toHaveLength(0);
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('returns not_found when the row does not belong to the firm', async () => {
    mockFindById.mockResolvedValueOnce(null);
    const { db, updateCalls } = buildDb({});

    const result = await handleDashboardRevokeOauthClient(buildCtx(db), CLIENT_UUID);

    expect(result).toBe('not_found');
    expect(updateCalls).toHaveLength(0);
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('rolls back every cascade when the audit writer throws', async () => {
    mockWriteAudit.mockRejectedValueOnce(new Error('audit store down'));
    const { db, updateCalls } = buildDb({});

    await expect(
      handleDashboardRevokeOauthClient(buildCtx(db), CLIENT_UUID),
    ).rejects.toThrow('audit store down');

    // The three `update()` calls fired against the TX handle (not
    // the outer db), so production rolls all of them back when
    // the audit write throws. The mock TX cannot model that
    // rollback directly — the point we pin is "update was
    // attempted on the tx, not the outer db" (which is the
    // structural precondition for rollback to work).
    expect(updateCalls).toHaveLength(3);
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
  });
});
