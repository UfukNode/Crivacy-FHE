// @vitest-environment node
/**
 * OAuth /userinfo handler tests.
 *
 * The bearer-token entry point's contract (RFC 6750):
 *   - Missing / malformed Authorization → 401 + WWW-Authenticate.
 *   - Unknown, revoked or expired token → 401 + invalid_token.
 *   - Valid token → claims scoped exactly to what the token covers.
 *
 * Every rejection path has to include the WWW-Authenticate header
 * and the standard OAuth error vocabulary. Clients that rely on that
 * header to decide whether to refresh vs. re-authorize would break
 * silently if we dropped it.
 */

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';
import type { OauthAccessToken } from '@/lib/db/schema/oauth-access-tokens';
import {
  canonicaliseScope,
  generateAccessToken,
  hashAccessToken,
  parseScope,
} from '@/lib/oauth';
import { handleOauthUserinfo } from '@/server/handlers/oauth-userinfo';
import * as oauthShared from '@/server/handlers/oauth-shared';
import * as repos from '@/server/repositories';

vi.mock('@/server/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof repos>();
  return {
    ...actual,
    findAccessToken: vi.fn(),
    touchAccessToken: vi.fn(),
  };
});

vi.mock('@/server/handlers/oauth-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof oauthShared>();
  return {
    ...actual,
    findActiveCredentialForUser: vi.fn(),
  };
});

const mockFindToken = vi.mocked(repos.findAccessToken);
const mockTouchToken = vi.mocked(repos.touchAccessToken);
const mockFindCredential = vi.mocked(oauthShared.findActiveCredentialForUser);

const FIXTURE_NOW = new Date('2026-04-17T12:00:00.000Z');
const USER_ID = 'u1111111-1111-4111-8111-111111111111';

function buildTokenRow(
  tokenHash: string,
  overrides: Partial<OauthAccessToken> = {},
): OauthAccessToken {
  return {
    tokenHash,
    clientId: 'c1111111-1111-4111-8111-111111111111',
    userId: USER_ID,
    consentId: 'con11111-1111-4111-8111-111111111111',
    authorizationCodeHash: null,
    scope: canonicaliseScope(parseScope('openid kyc')),
    expiresAt: new Date(FIXTURE_NOW.getTime() + 3600 * 1000),
    revokedAt: null,
    revokedReason: null,
    lastUsedAt: null,
    createdAt: FIXTURE_NOW,
    ...overrides,
  };
}

function buildUserinfoRequest(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers['authorization'] = authHeader;
  return new NextRequest(
    new Request('https://app.crivacy.test/api/v1/oauth/userinfo', {
      method: 'GET',
      headers,
    }),
  );
}

const deps = {
  db: { _tag: 'mock' } as unknown as CrivacyDatabase,
  now: FIXTURE_NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTouchToken.mockResolvedValue(undefined);
  mockFindCredential.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleOauthUserinfo — auth header guards', () => {
  it('rejects a request without an Authorization header', async () => {
    const res = await handleOauthUserinfo(deps, buildUserinfoRequest());
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  it('rejects a non-Bearer scheme', async () => {
    const res = await handleOauthUserinfo(deps, buildUserinfoRequest('Basic dXNlcjpwYXNz'));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
  });

  it('rejects a Bearer header with an empty token value', async () => {
    const res = await handleOauthUserinfo(deps, buildUserinfoRequest('Bearer   '));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });
});

describe('handleOauthUserinfo — token validity', () => {
  it('returns invalid_token when the token is unknown', async () => {
    mockFindToken.mockResolvedValue(null);
    const res = await handleOauthUserinfo(
      deps,
      buildUserinfoRequest(`Bearer ${generateAccessToken()}`),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('invalid_token');
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
  });

  it('returns invalid_token when the token is revoked', async () => {
    const raw = generateAccessToken();
    mockFindToken.mockResolvedValue(
      buildTokenRow(hashAccessToken(raw), { revokedAt: FIXTURE_NOW }),
    );
    const res = await handleOauthUserinfo(deps, buildUserinfoRequest(`Bearer ${raw}`));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    expect(body.error_description).toContain('revoked');
  });

  it('returns invalid_token when the token has expired', async () => {
    const raw = generateAccessToken();
    mockFindToken.mockResolvedValue(
      buildTokenRow(hashAccessToken(raw), {
        expiresAt: new Date(FIXTURE_NOW.getTime() - 1),
      }),
    );
    const res = await handleOauthUserinfo(deps, buildUserinfoRequest(`Bearer ${raw}`));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    expect(body.error_description).toContain('expired');
  });
});

describe('handleOauthUserinfo — happy path', () => {
  it('returns the claim set scoped to the token scope and touches last_used_at', async () => {
    const raw = generateAccessToken();
    const tokenRow = buildTokenRow(hashAccessToken(raw));
    mockFindToken.mockResolvedValue(tokenRow);

    const res = await handleOauthUserinfo(deps, buildUserinfoRequest(`Bearer ${raw}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    // openid → sub; kyc with null credential → no identity_verified.
    expect(body.sub).toBe(USER_ID);
    // Touch is fire-and-forget, but it should have been scheduled —
    // give the microtask queue a tick to flush before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockTouchToken).toHaveBeenCalledWith(deps.db, tokenRow.tokenHash, FIXTURE_NOW);
  });

  it('emits kyc claims when a credential is found and kyc scope is granted', async () => {
    const raw = generateAccessToken();
    mockFindToken.mockResolvedValue(buildTokenRow(hashAccessToken(raw)));
    mockFindCredential.mockResolvedValue({
      id: 'cred-userinfo-fixture',
      firmId: 'firm-userinfo-fixture',
      userRef: USER_ID,
      contractId: null,
      level: 'enhanced',
      status: 'active',
      identityVerified: true,
      livenessVerified: true,
      addressVerified: false,
      humanScore: 92,
      proofHash: '0xabc' + 'd'.repeat(63),
      validator: 'didit',
      network: 'mainnet',
      validFrom: FIXTURE_NOW,
      validUntil: new Date(FIXTURE_NOW.getTime() + 365 * 24 * 60 * 60 * 1000),
      confirmedAt: null,
      revokedAt: null,
      revokedReason: null,
      expiredAt: null,
      disclosureBlob: null,
      operatorParty: 'Crivacy::operator',
      userParty: 'User::test',
      templateId: 'crivacy-kyc:Crivacy.KYCCredential:KYCCredential',
      updatedAt: FIXTURE_NOW,
    });

    const res = await handleOauthUserinfo(deps, buildUserinfoRequest(`Bearer ${raw}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sub).toBe(USER_ID);
    expect(body.identity_verified).toBe(true);
    expect(body.liveness_verified).toBe(true);
    // `kyc:address` was NOT requested, so it stays out of the claim
    // set. `credential` IS auto-bundled with every `kyc*` scope by
    // `expandImplicitScopes`, so the Chain reference fields DO
    // surface here.
    expect(body.address_verified).toBeUndefined();
    expect(body.credential_proof_hash).toBe('0xabc' + 'd'.repeat(63));
  });
});
