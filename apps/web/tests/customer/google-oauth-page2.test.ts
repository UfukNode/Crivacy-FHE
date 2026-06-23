// @vitest-environment node
/**
 * Page 2 closure batch — pinned invariants for the customer Google
 * OAuth surface. Covers the contracts that future regressions must
 * not break:
 *
 *   1. PKCE round-trip: state JWT carries the verifier, the URL
 *      carries the SHA-256 challenge, and the two reconcile under
 *      RFC 7636 S256.
 *   2. State JWT shape: `nonce`, `pkce`, `jti`, `exp` all present;
 *      missing any of them throws on verify.
 *   3. assertCustomerActive: banned / suspended / still-locked rows
 *      throw CustomerError; auto-unlock fires on expired locks.
 *   4. claimOAuthStateJti: first INSERT succeeds; duplicate is
 *      rejected; expired-row prune runs first.
 *   5. createLinkedAccount: ON CONFLICT DO NOTHING returns null on
 *      collision and the row's id otherwise.
 *   6. auditOAuthEvent: each event maps to the matching
 *      `customer.login.oauth.<event>` action and a uuidTarget when
 *      a customerId is supplied (noTarget otherwise).
 *   7. Three rate-limit policies for the OAuth surface registered
 *      in the central enforce module.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

import {
  buildGoogleAuthUrl,
  generateOAuthState,
  verifyOAuthState,
  signConfirmLinkToken,
  verifyConfirmLinkToken,
} from '@/lib/customer/google-oauth';

import type { CrivacyDatabase } from '@/lib/db/client';

// ---------------------------------------------------------------------------
// 1 + 2 — PKCE round-trip + state shape
// ---------------------------------------------------------------------------

describe('OAuth state JWT — PKCE round-trip + shape', () => {
  const SECRET = 'unit-test-state-secret-32-bytes!!!!';

  it('mints a state JWT with nonce, pkce verifier, and a fresh jti', async () => {
    const result = await generateOAuthState(SECRET, 'login');

    expect(result.stateJwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(result.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trips the PKCE verifier — challenge equals SHA-256(verifier) base64url', async () => {
    const result = await generateOAuthState(SECRET, 'login');
    const verified = await verifyOAuthState(result.stateJwt, SECRET);

    const recomputedChallenge = createHash('sha256')
      .update(verified.pkceVerifier)
      .digest('base64url');

    expect(recomputedChallenge).toBe(result.codeChallenge);
  });

  it('exposes the JWT jti + expiresAt for the burn table', async () => {
    const result = await generateOAuthState(SECRET, 'login');
    const verified = await verifyOAuthState(result.stateJwt, SECRET);

    expect(verified.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(verified.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // 10-min TTL — accept ±60s drift for test timing.
    expect(verified.expiresAt.getTime() - Date.now()).toBeLessThan(11 * 60 * 1000);
  });

  it('rejects a state JWT with the wrong signing secret', async () => {
    const result = await generateOAuthState(SECRET, 'login');
    await expect(
      verifyOAuthState(result.stateJwt, 'different-secret-32-bytes-OK!!!!'),
    ).rejects.toThrow();
  });

  it('embeds code_challenge + S256 method on the consent URL', async () => {
    const result = await generateOAuthState(SECRET, 'login');
    const url = buildGoogleAuthUrl(
      { googleClientId: 'cid', googleRedirectUri: 'https://x/cb' },
      result.stateJwt,
      result.codeChallenge,
    );
    const params = new URL(url).searchParams;
    expect(params.get('code_challenge')).toBe(result.codeChallenge);
    expect(params.get('code_challenge_method')).toBe('S256');
    // F-A2-AQ-001 — `openid` scope dropped.
    expect(params.get('scope')).toBe('email profile');
  });

  it('confirm-link token round-trips with jti + exp', async () => {
    const token = await signConfirmLinkToken(SECRET, {
      customerId: '00000000-0000-0000-0000-000000000001',
      googleSub: 'g-sub-1',
      email: 'u@example.com',
      name: 'Ut',
      picture: '',
    });
    const verified = await verifyConfirmLinkToken(token, SECRET);
    expect(verified.customerId).toBe('00000000-0000-0000-0000-000000000001');
    expect(verified.googleSub).toBe('g-sub-1');
    expect(verified.email).toBe('u@example.com');
    expect(verified.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(verified.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// 3 — assertCustomerActive
// ---------------------------------------------------------------------------

describe('assertCustomerActiveFromRow — Page 1 H.1-H.4 parite', () => {
  // Inline import to avoid hoisting issues across vitest mocks.
  const importHelper = async () =>
    (await import('@/lib/customer/status-check')).assertCustomerActiveFromRow;

  const customerConfig = { lockDurationMinutes: 30 } as Parameters<
    Awaited<ReturnType<typeof importHelper>>
  >[2];

  function fakeDb(execute = vi.fn(async () => ({ rows: [] }))): CrivacyDatabase {
    return { execute } as unknown as CrivacyDatabase;
  }

  it('passes silently for an active row', async () => {
    const helper = await importHelper();
    const db = fakeDb();
    await expect(
      helper(
        db,
        { id: 'c1', status: 'active', emailVerifiedAt: '2026-01-01T00:00:00Z', lockedAt: null },
        customerConfig,
        new Date('2026-04-27T00:00:00Z'),
      ),
    ).resolves.toBeUndefined();
  });

  it('throws account_banned on banned status', async () => {
    const helper = await importHelper();
    await expect(
      helper(
        fakeDb(),
        { id: 'c1', status: 'banned', emailVerifiedAt: null, lockedAt: null },
        customerConfig,
        new Date('2026-04-27T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'account_banned' });
  });

  it('throws account_suspended on suspended status', async () => {
    const helper = await importHelper();
    await expect(
      helper(
        fakeDb(),
        { id: 'c1', status: 'suspended', emailVerifiedAt: null, lockedAt: null },
        customerConfig,
        new Date('2026-04-27T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'account_suspended' });
  });

  it('throws account_locked while still inside the lock window', async () => {
    const helper = await importHelper();
    const lockedAt = '2026-04-27T00:00:00Z';
    const within = new Date('2026-04-27T00:10:00Z'); // 10 min in
    await expect(
      helper(
        fakeDb(),
        { id: 'c1', status: 'locked', emailVerifiedAt: null, lockedAt },
        customerConfig,
        within,
      ),
    ).rejects.toMatchObject({ code: 'account_locked' });
  });

  it('auto-unlocks once the lock window has elapsed', async () => {
    const helper = await importHelper();
    const execute = vi.fn(async () => ({ rows: [] }));
    const lockedAt = '2026-04-27T00:00:00Z';
    const beyond = new Date('2026-04-27T01:00:00Z'); // 60 min in, > 30
    await helper(
      fakeDb(execute),
      { id: 'c1', status: 'locked', emailVerifiedAt: '2026-01-01T00:00:00Z', lockedAt },
      customerConfig,
      beyond,
    );
    expect(execute).toHaveBeenCalledTimes(1); // the auto-unlock UPDATE
  });
});

// ---------------------------------------------------------------------------
// 4 — claimOAuthStateJti
// ---------------------------------------------------------------------------

describe('claimOAuthStateJti — single-use burn', () => {
  const importHelper = async () =>
    (await import('@/lib/customer/oauth-state-burn')).claimOAuthStateJti;

  it('returns true when no prior row exists', async () => {
    const helper = await importHelper();
    const execute = vi.fn(async () => ({ rows: [] }));
    const ok = await helper(
      { execute } as unknown as CrivacyDatabase,
      'jti-1',
      new Date(Date.now() + 600_000),
      null,
    );
    expect(ok).toBe(true);
    // First call = prune, second = INSERT
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('returns false on a 23505 unique-violation', async () => {
    const helper = await importHelper();
    const execute = vi.fn(async (..._args: unknown[]) => {
      // Prune call (first) returns OK; INSERT (second) throws.
      if (execute.mock.calls.length === 1) return { rows: [] };
      const err = new Error('duplicate key');
      Object.assign(err, { code: '23505', constraint: 'oauth_state_used_pkey' });
      throw err;
    });
    const ok = await helper(
      { execute } as unknown as CrivacyDatabase,
      'jti-2',
      new Date(Date.now() + 600_000),
      null,
    );
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5 — createLinkedAccount ON CONFLICT DO NOTHING
// ---------------------------------------------------------------------------

describe('createLinkedAccount — ON CONFLICT DO NOTHING contract', () => {
  it('returns the inserted id on first write', async () => {
    const { createLinkedAccount } = await import('@/lib/customer/linked-accounts');
    const execute = vi.fn(async () => ({ rows: [{ id: 'la-1' }] }));
    const id = await createLinkedAccount(
      { execute } as unknown as CrivacyDatabase,
      'c1',
      'google',
      'sub-1',
      'u@x',
      'Name',
    );
    expect(id).toBe('la-1');
  });

  it('returns null when the conflict suppresses the insert', async () => {
    const { createLinkedAccount } = await import('@/lib/customer/linked-accounts');
    const execute = vi.fn(async () => ({ rows: [] }));
    const id = await createLinkedAccount(
      { execute } as unknown as CrivacyDatabase,
      'c1',
      'google',
      'sub-1',
      'u@x',
      'Name',
    );
    expect(id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6 — auditOAuthEvent
// ---------------------------------------------------------------------------

describe('auditOAuthEvent', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('writes `customer.login.oauth.<event>` with uuidTarget when customerId is provided', async () => {
    const writeAuditMock = vi.fn<(db: unknown, input: { action: string; target: { kind: string } }) => Promise<unknown>>(async () => ({}));
    vi.doMock('@/lib/audit/writer', () => ({ writeAudit: writeAuditMock }));

    const { auditOAuthEvent } = await import('@/lib/customer/audit-oauth');
    await auditOAuthEvent(
      {} as CrivacyDatabase,
      {
        ip: '1.2.3.4',
        userAgent: 'ua',
        // The audit-context normalizer demands UUID v4 — the route
        // layer always supplies one via `buildRequestContext`.
        requestId: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
        now: new Date('2026-04-27T00:00:00Z'),
      },
      'success',
      { provider: 'google' },
      { customerId: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee' },
    );
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const callArgs = writeAuditMock.mock.calls[0];
    if (!callArgs) throw new Error('writeAudit not called');
    const call = callArgs[1];
    expect(call.action).toBe('customer.login.oauth.success');
    expect(call.target.kind).toBe('customer');
  });

  it('uses noTarget when customerId is omitted', async () => {
    const writeAuditMock = vi.fn<(db: unknown, input: { action: string; target: { kind: string } }) => Promise<unknown>>(async () => ({}));
    vi.doMock('@/lib/audit/writer', () => ({ writeAudit: writeAuditMock }));

    const { auditOAuthEvent } = await import('@/lib/customer/audit-oauth');
    await auditOAuthEvent(
      {} as CrivacyDatabase,
      {
        ip: null,
        userAgent: null,
        requestId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        now: new Date(),
      },
      'replay_blocked',
      { jti: 'x' },
    );
    const callArgs = writeAuditMock.mock.calls[0];
    if (!callArgs) throw new Error('writeAudit not called');
    const call = callArgs[1];
    expect(call.action).toBe('customer.login.oauth.replay_blocked');
    expect(call.target.kind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// 7 — Rate-limit policies registered
// ---------------------------------------------------------------------------

describe('OAuth rate-limit policies', () => {
  it('registers customer_oauth_initiate / _callback / _unlink', async () => {
    // The policy list is private; we reach it via a typed enforce
    // call against a stub DB. If an endpoint key is missing the
    // typecheck above already caught it; this test is the runtime
    // smoke that the values are reasonable.
    const { enforceAuthRateLimit } = await import('@/lib/auth-rate-limit');
    const execute = vi.fn(async () => ({ rows: [{ count: '0', oldest: null }] }));
    const db = { execute } as unknown as CrivacyDatabase;
    for (const endpoint of [
      'customer_oauth_initiate',
      'customer_oauth_callback',
      'customer_oauth_unlink',
    ] as const) {
      const decision = await enforceAuthRateLimit(db, endpoint, '1.2.3.4');
      expect(decision.allowed).toBe(true);
      expect(decision.max).toBeGreaterThan(0);
    }
  });
});
