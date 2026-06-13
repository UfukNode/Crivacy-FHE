// @vitest-environment node
/**
 * OAuth consent bootstrap resolver — unit tests.
 *
 * `resolveOauthConsentBootstrap` is the single source of truth for
 * the consent page's initial state. It's reached from two call
 * sites: the `/api/v1/oauth/consent/bootstrap` route (cookie-
 * authenticated, rate-limited) and the `/oauth/consent` server
 * component (direct in-process call — no self-fetch, so no host
 * header spoof, no cookie exfiltration over the wire). These tests
 * pin the outcome contract so a regression in either caller
 * surfaces loud.
 *
 * What's covered:
 *   - every `ok: false` branch returns the expected code + HTTP
 *     status the callers map to,
 *   - the happy path surfaces the authorize request, client
 *     metadata, scope details, KYC gate signals, cached-consent
 *     fast path exactly as the consent page expects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';
import type { OauthAuthorizationRequest } from '@/lib/db/schema/oauth-authorization-requests';
import type { OauthClient } from '@/lib/db/schema/oauth-clients';
import type { OauthConsent } from '@/lib/db/schema/oauth-consents';
import { canonicaliseScope, hashScope, parseScope } from '@/lib/oauth';
import { resolveOauthConsentBootstrap } from '@/server/handlers/oauth-bootstrap';
import * as oauthShared from '@/server/handlers/oauth-shared';
import * as repos from '@/server/repositories';

vi.mock('@/server/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof repos>();
  return {
    ...actual,
    findAuthorizationRequest: vi.fn(),
    findActiveConsent: vi.fn(),
    attachUserToAuthorizationRequest: vi.fn(),
  };
});

// Keep `ensureAuthRequestOwnership` real — it delegates to the
// mocked repositories above, so exercising the real code path
// keeps the test honest about the attach-then-check contract.
vi.mock('@/server/handlers/oauth-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof oauthShared>();
  return {
    ...actual,
    findActiveCredentialForUser: vi.fn(),
  };
});

const mockFindAuthRequest = vi.mocked(repos.findAuthorizationRequest);
const mockFindActiveConsent = vi.mocked(repos.findActiveConsent);
const mockAttachUser = vi.mocked(repos.attachUserToAuthorizationRequest);
const mockFindCredential = vi.mocked(oauthShared.findActiveCredentialForUser);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-21T12:00:00.000Z');
const REQUEST_ID = 'req-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CUSTOMER_ID = 'c1111111-1111-4111-8111-111111111111';
const CLIENT_UUID = 'd1111111-1111-4111-8111-111111111111';
const REDIRECT_URI = 'https://firm.example.com/oauth/callback';

const FIXTURE_CLIENT: OauthClient = {
  id: CLIENT_UUID,
  firmId: 'f1111111-1111-4111-8111-111111111111',
  clientId: 'crv_oauth_live_fixture_client_id_abcd',
  clientSecretHash: null,
  name: 'Fixture Client',
  description: 'Test client for bootstrap unit tests.',
  logoUrl: 'https://firm.example.com/logo.svg',
  homepageUrl: 'https://firm.example.com',
  redirectUris: [REDIRECT_URI],
  allowedScopes: ['openid', 'kyc'],
  isPublicClient: false,
  consentTtlDays: 90,
  metadata: {},
  createdByFirmUserId: null,
  failedSecretAttempts: 0,
  secretLockedUntil: null,
  revokedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function buildAuthRequest(
  overrides: Partial<OauthAuthorizationRequest> = {},
): OauthAuthorizationRequest {
  return {
    id: 'auth-req-uuid',
    requestId: REQUEST_ID,
    clientId: CLIENT_UUID,
    userId: null,
    redirectUri: REDIRECT_URI,
    scope: 'openid kyc',
    state: 'csrf-xyz',
    nonce: null,
    codeChallenge: null,
    codeChallengeMethod: null,
    uiLocales: null,
    ip: '203.0.113.5',
    userAgent: 'test/1.0',
    completedAt: null,
    expiresAt: new Date(NOW.getTime() + 900 * 1000),
    createdAt: NOW,
    ...overrides,
  } as OauthAuthorizationRequest;
}

function buildConsent(overrides: Partial<OauthConsent> = {}): OauthConsent {
  const scopes = parseScope('openid kyc');
  return {
    id: 'e1111111-1111-4111-8111-111111111111',
    userId: CUSTOMER_ID,
    clientId: CLIENT_UUID,
    scope: canonicaliseScope(scopes),
    scopeHash: hashScope(scopes),
    grantedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    revokedReason: null,
    lastUsedAt: null,
    ...overrides,
  };
}

/**
 * DB stub whose `select(...)` path returns the supplied client row
 * to any caller. The resolver uses Drizzle's builder-chain for the
 * client lookup, so we only need to satisfy the top-level shape.
 */
function buildDb(clientRow: OauthClient | null): CrivacyDatabase {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (clientRow !== null ? [clientRow] : []),
        }),
      }),
    }),
  } as unknown as CrivacyDatabase;
}

function buildDeps(dbOverride?: CrivacyDatabase) {
  return {
    db: dbOverride ?? buildDb(FIXTURE_CLIENT),
    now: NOW,
    customer: {
      id: CUSTOMER_ID,
      email: 'user@test.example',
      kycLevel: 'kyc_1',
    },
  };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: user owns the authorize request already.
  mockAttachUser.mockResolvedValue(true);
  mockFindActiveConsent.mockResolvedValue(null);
  // Default: user has a basic credential, so the KYC gate passes
  // for `openid kyc` (requires basic).
  mockFindCredential.mockResolvedValue({
    id: 'cred-bootstrap-fixture',
    firmId: 'firm-bootstrap-fixture',
    userRef: 'user-bootstrap-fixture',
    contractId: null,
    level: 'basic',
    status: 'active',
    identityVerified: true,
    livenessVerified: true,
    addressVerified: false,
    humanScore: 90,
    proofHash: 'sha256:fixture',
    validator: 'didit',
    network: 'sepolia',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: new Date('2030-01-01T00:00:00.000Z'),
    confirmedAt: null,
    revokedAt: null,
    revokedReason: null,
    expiredAt: null,
    disclosureBlob: null,
    operatorParty: 'Crivacy::operator',
    userParty: 'User::test',
    templateId: 'crivacy-kyc:Crivacy.KYCCredential:KYCCredential',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('resolveOauthConsentBootstrap — error paths', () => {
  it('returns not_found/404 when the authorize request is missing', async () => {
    mockFindAuthRequest.mockResolvedValue(null);
    const outcome = await resolveOauthConsentBootstrap(buildDeps(), REQUEST_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unexpected ok');
    expect(outcome.code).toBe('not_found');
    expect(outcome.status).toBe(404);
  });

  it('returns conflict/409 when the authorize request has completedAt', async () => {
    mockFindAuthRequest.mockResolvedValue(
      buildAuthRequest({ completedAt: new Date(NOW.getTime() - 1000) }),
    );
    const outcome = await resolveOauthConsentBootstrap(buildDeps(), REQUEST_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unexpected ok');
    expect(outcome.code).toBe('conflict');
    expect(outcome.status).toBe(409);
  });

  it('returns expired/410 when the authorize request has past its TTL', async () => {
    mockFindAuthRequest.mockResolvedValue(
      buildAuthRequest({ expiresAt: new Date(NOW.getTime() - 1) }),
    );
    const outcome = await resolveOauthConsentBootstrap(buildDeps(), REQUEST_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unexpected ok');
    expect(outcome.code).toBe('expired');
    expect(outcome.status).toBe(410);
  });

  it('returns owner_mismatch/403 when the request is bound to a different customer', async () => {
    mockFindAuthRequest.mockResolvedValue(
      buildAuthRequest({ userId: 'c2222222-2222-4222-8222-222222222222' }),
    );
    const outcome = await resolveOauthConsentBootstrap(buildDeps(), REQUEST_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unexpected ok');
    expect(outcome.code).toBe('owner_mismatch');
    expect(outcome.status).toBe(403);
  });

  it('returns not_found/404 when the OAuth client has been revoked', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest());
    const outcome = await resolveOauthConsentBootstrap(
      { ...buildDeps(buildDb(null)) },
      REQUEST_ID,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unexpected ok');
    expect(outcome.code).toBe('not_found');
    expect(outcome.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('resolveOauthConsentBootstrap — happy path', () => {
  it('surfaces the authorize request, client, scopes, and KYC gate signals', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest());

    const outcome = await resolveOauthConsentBootstrap(buildDeps(), REQUEST_ID);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unexpected error');

    expect(outcome.snapshot.request.id).toBe(REQUEST_ID);
    expect(outcome.snapshot.request.redirectUri).toBe(REDIRECT_URI);
    expect(outcome.snapshot.request.scope).toContain('openid');
    expect(outcome.snapshot.request.scope).toContain('kyc');
    expect(outcome.snapshot.request.scopes.length).toBeGreaterThanOrEqual(2);
    expect(outcome.snapshot.request.scopes.every((s) => typeof s.description === 'string')).toBe(
      true,
    );

    expect(outcome.snapshot.client.name).toBe(FIXTURE_CLIENT.name);
    expect(outcome.snapshot.client.logoUrl).toBe(FIXTURE_CLIENT.logoUrl);

    expect(outcome.snapshot.user.id).toBe(CUSTOMER_ID);
    expect(outcome.snapshot.user.email).toBe('user@test.example');

    // Customer has a basic credential; `openid kyc` needs basic.
    // Gate lets them through — `needsKyc` + `needsKycUpgrade` both
    // false, `missingScopes` empty.
    expect(outcome.snapshot.kycGate.needsKyc).toBe(false);
    expect(outcome.snapshot.kycGate.needsKycUpgrade).toBe(false);
    expect(outcome.snapshot.kycGate.missingScopes).toEqual([]);

    // No cached consent in this fixture.
    expect(outcome.snapshot.cachedConsent).toBeNull();
  });

  it('surfaces the cached-consent fast path when an active row covers the scope', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest());
    mockFindActiveConsent.mockResolvedValue(buildConsent());

    const outcome = await resolveOauthConsentBootstrap(buildDeps(), REQUEST_ID);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unexpected error');
    expect(outcome.snapshot.cachedConsent).not.toBeNull();
    expect(outcome.snapshot.cachedConsent?.id).toBe('e1111111-1111-4111-8111-111111111111');
  });

  it('flags the KYC gate when the customer has no active credential', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest());
    mockFindCredential.mockResolvedValue(null);

    const outcome = await resolveOauthConsentBootstrap(buildDeps(), REQUEST_ID);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unexpected error');
    expect(outcome.snapshot.kycGate.needsKyc).toBe(true);
    expect(outcome.snapshot.kycGate.missingScopes.length).toBeGreaterThan(0);
  });

  it('TOFU-attaches the caller when the authorize request has no owner yet', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest({ userId: null }));
    mockAttachUser.mockResolvedValue(true);

    const outcome = await resolveOauthConsentBootstrap(buildDeps(), REQUEST_ID);
    expect(outcome.ok).toBe(true);
    expect(mockAttachUser).toHaveBeenCalledTimes(1);
    const [, attachReq, attachUser] = mockAttachUser.mock.calls[0]!;
    expect(attachReq).toBe(REQUEST_ID);
    expect(attachUser).toBe(CUSTOMER_ID);
  });
});
