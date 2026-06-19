// @vitest-environment node
/**
 * OAuth /token handler tests.
 *
 * Covers the security invariants that RFC 9700 §2.1.1 calls out as
 * MUST-haves for the authorization-code grant:
 *
 *   - Wrong client_secret → invalid_client (confidential clients).
 *   - Code unknown / expired / issued to a different client →
 *     invalid_grant.
 *   - Code reuse → revoke every token minted from that code, then
 *     invalid_grant.
 *   - redirect_uri must byte-match the one used at authorize.
 *   - PKCE verifier mismatch → invalid_grant.
 *   - IP binding — confidential clients only.
 *
 * The handler lives independently of the app-route middleware chain,
 * so we drive it directly with a stubbed NextRequest + repo mocks.
 */

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';
import type { OauthAuthorizationCode } from '@/lib/db/schema/oauth-authorization-codes';
import type { OauthClient } from '@/lib/db/schema/oauth-clients';
import type { OauthConsent } from '@/lib/db/schema/oauth-consents';
import {
  computeCodeChallenge,
  generateAuthorizationCode,
  hashAuthorizationCode,
  hashClientSecret,
  hashScope,
  canonicaliseScope,
  parseScope,
} from '@/lib/oauth';
import { handleOauthToken } from '@/server/handlers/oauth-token';
import * as oauthShared from '@/server/handlers/oauth-shared';
import * as repos from '@/server/repositories';

vi.mock('@/server/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof repos>();
  return {
    ...actual,
    findOauthClientByClientId: vi.fn(),
    findAuthorizationCode: vi.fn(),
    burnAuthorizationCode: vi.fn(),
    revokeTokensMintedFromCode: vi.fn(),
    findActiveConsent: vi.fn(),
    insertConsent: vi.fn(),
    insertAccessToken: vi.fn(),
  };
});

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => undefined),
  writeAuditBatch: vi.fn(async () => undefined),
}));

vi.mock('@/server/handlers/oauth-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof oauthShared>();
  return {
    ...actual,
    findActiveCredentialForUser: vi.fn(),
  };
});

const mockFindClient = vi.mocked(repos.findOauthClientByClientId);
const mockFindCode = vi.mocked(repos.findAuthorizationCode);
const mockBurnCode = vi.mocked(repos.burnAuthorizationCode);
const mockRevokeTokens = vi.mocked(repos.revokeTokensMintedFromCode);
const mockFindConsent = vi.mocked(repos.findActiveConsent);
const mockInsertConsent = vi.mocked(repos.insertConsent);
const mockInsertAccessToken = vi.mocked(repos.insertAccessToken);
const mockFindCredential = vi.mocked(oauthShared.findActiveCredentialForUser);

const FIXTURE_NOW = new Date('2026-04-17T12:00:00.000Z');
const REDIRECT_URI = 'https://firm.example.com/oauth/callback';
const USER_ID = 'u1111111-1111-4111-8111-111111111111';
const RAW_SECRET = 'confidential-raw-secret-value-aabbcc';

let fixtureClient: OauthClient;
let publicClient: OauthClient;

function buildClient(overrides: Partial<OauthClient> = {}): OauthClient {
  return {
    id: 'c1111111-1111-4111-8111-111111111111',
    firmId: 'f1111111-1111-4111-8111-111111111111',
    clientId: 'crv_oauth_live_fixture_client_id_abcd',
    clientSecretHash: null,
    name: 'Fixture Client',
    description: null,
    logoUrl: null,
    homepageUrl: null,
    redirectUris: [REDIRECT_URI],
    allowedScopes: ['openid', 'kyc'],
    isPublicClient: false,
    consentTtlDays: 90,
    metadata: {},
    createdByFirmUserId: null,
    failedSecretAttempts: 0,
    secretLockedUntil: null,
    revokedAt: null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

function buildCodeRow(
  rawCode: string,
  overrides: Partial<OauthAuthorizationCode> = {},
): OauthAuthorizationCode {
  return {
    codeHash: hashAuthorizationCode(rawCode),
    clientId: fixtureClient.id,
    userId: USER_ID,
    scope: 'kyc openid',
    redirectUri: REDIRECT_URI,
    nonce: null,
    codeChallenge: null,
    codeChallengeMethod: null,
    ipBoundTo: '203.0.113.5',
    usedAt: null,
    expiresAt: new Date(FIXTURE_NOW.getTime() + 60 * 1000),
    createdAt: FIXTURE_NOW,
    ...overrides,
  };
}

function buildConsent(overrides: Partial<OauthConsent> = {}): OauthConsent {
  const scopes = parseScope('openid kyc');
  return {
    id: 'con11111-1111-4111-8111-111111111111',
    userId: USER_ID,
    clientId: fixtureClient.id,
    scope: canonicaliseScope(scopes),
    scopeHash: hashScope(scopes),
    grantedAt: FIXTURE_NOW,
    expiresAt: new Date(FIXTURE_NOW.getTime() + 90 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    revokedReason: null,
    lastUsedAt: null,
    ...overrides,
  };
}

function buildTokenRequest(form: Record<string, string>, overrideHeaders: Record<string, string> = {}): NextRequest {
  const body = new URLSearchParams(form).toString();
  return new NextRequest(
    new Request('https://app.crivacy.test/api/v1/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...overrideHeaders,
      },
      body,
    }),
  );
}

/**
 * Mock DB stub — handlers only threads this through; the calls
 * that actually hit Drizzle are the repo helpers + a couple of
 * direct `db.update(...).set(...).where(...)` chains the token
 * handler issues for the `failed_secret_attempts` counter. The
 * chain is stubbed to a no-op here so the counter path compiles
 * and runs without needing a real Postgres.
 */
const noopUpdateChain = {
  set: () => ({
    where: () => Promise.resolve(),
  }),
};
// The token handler now runs burn + consent + insertAccessToken
// inside a `db.transaction(cb)` block so a failure mid-mint rolls
// the code burn back (prevents a false `code_reuse_detected`
// alarm on the next retry). The mock's transaction forwards the
// callback to the same db handle — the repository writes are all
// `vi.mock`ed above so the real argument is never queried.
const mockDb: unknown = {
  _tag: 'mock',
  update: () => noopUpdateChain,
  transaction: async <T>(cb: (tx: CrivacyDatabase) => Promise<T>): Promise<T> =>
    cb(mockDb as CrivacyDatabase),
};
const deps = {
  db: mockDb as CrivacyDatabase,
  now: FIXTURE_NOW,
  ip: '203.0.113.5',
  issuerUrl: 'https://app.crivacy.test',
};

beforeEach(async () => {
  vi.clearAllMocks();
  fixtureClient = buildClient({
    clientSecretHash: await hashClientSecret(RAW_SECRET),
  });
  publicClient = buildClient({
    id: 'c2222222-2222-4222-8222-222222222222',
    clientId: 'crv_oauth_live_public_spa____abcd',
    isPublicClient: true,
    clientSecretHash: null,
  });
  // Defaults — individual tests override.
  mockFindClient.mockResolvedValue(null);
  mockFindCode.mockResolvedValue(null);
  mockBurnCode.mockResolvedValue(true);
  mockRevokeTokens.mockResolvedValue(undefined);
  mockFindConsent.mockResolvedValue(null);
  mockInsertConsent.mockImplementation(async (_db, _input) => buildConsent());
  mockInsertAccessToken.mockResolvedValue(undefined);
  mockFindCredential.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleOauthToken — request shape', () => {
  it('rejects non-urlencoded content type', async () => {
    const req = new NextRequest(
      new Request('https://app.crivacy.test/api/v1/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    const res = await handleOauthToken(deps, req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  it('rejects a non-authorization-code grant type', async () => {
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({ grant_type: 'password', username: 'a', password: 'b' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_grant_type');
  });

  it('rejects when mandatory params are missing', async () => {
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({ grant_type: 'authorization_code', client_id: 'x' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });
});

describe('handleOauthToken — client auth', () => {
  it('returns invalid_client (401) when the client is unknown', async () => {
    mockFindClient.mockResolvedValue(null);
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: 'c',
        redirect_uri: REDIRECT_URI,
        client_id: 'crv_oauth_live_unknown_________a',
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_client');
  });

  it('returns invalid_client (401) when the client is revoked', async () => {
    mockFindClient.mockResolvedValue({ ...fixtureClient, revokedAt: FIXTURE_NOW });
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: 'c',
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_client');
  });

  it('returns invalid_client when a confidential client omits client_secret', async () => {
    mockFindClient.mockResolvedValue(fixtureClient);
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: 'c',
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_client');
    expect(mockFindCode).not.toHaveBeenCalled();
  });

  it('returns invalid_client when client_secret does not match', async () => {
    mockFindClient.mockResolvedValue(fixtureClient);
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: 'c',
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: 'the-wrong-secret',
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_client');
    expect(mockFindCode).not.toHaveBeenCalled();
  });
});

describe('handleOauthToken — code validation', () => {
  beforeEach(() => {
    mockFindClient.mockResolvedValue(fixtureClient);
  });

  it('returns invalid_grant when the code is unknown', async () => {
    mockFindCode.mockResolvedValue(null);
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: generateAuthorizationCode(),
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_grant when the code was issued to a different client', async () => {
    const raw = generateAuthorizationCode();
    mockFindCode.mockResolvedValue(buildCodeRow(raw, { clientId: 'other-client-uuid' }));
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_grant when redirect_uri does not match the authorize-time value', async () => {
    const raw = generateAuthorizationCode();
    mockFindCode.mockResolvedValue(buildCodeRow(raw));
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: 'https://firm.example.com/a-different-cb',
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_grant when the code has expired', async () => {
    const raw = generateAuthorizationCode();
    mockFindCode.mockResolvedValue(
      buildCodeRow(raw, { expiresAt: new Date(FIXTURE_NOW.getTime() - 1) }),
    );
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('triggers the code-reuse defence when a used code is presented again', async () => {
    const raw = generateAuthorizationCode();
    const codeRow = buildCodeRow(raw, { usedAt: new Date(FIXTURE_NOW.getTime() - 5_000) });
    mockFindCode.mockResolvedValue(codeRow);
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    expect(mockRevokeTokens).toHaveBeenCalledTimes(1);
    const [, codeHashArg, , reason] = mockRevokeTokens.mock.calls[0]!;
    expect(codeHashArg).toBe(hashAuthorizationCode(raw));
    expect(reason).toBe('code_reuse_detected');
  });

  it('returns invalid_grant when the concurrent burn loses the race', async () => {
    const raw = generateAuthorizationCode();
    mockFindCode.mockResolvedValue(buildCodeRow(raw));
    mockBurnCode.mockResolvedValue(false);
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    expect(mockInsertAccessToken).not.toHaveBeenCalled();
  });
});

describe('handleOauthToken — PKCE', () => {
  beforeEach(() => {
    mockFindClient.mockResolvedValue(fixtureClient);
  });

  it('returns invalid_request when code has a challenge but no verifier is supplied', async () => {
    const raw = generateAuthorizationCode();
    const verifier = 'a'.repeat(64);
    mockFindCode.mockResolvedValue(
      buildCodeRow(raw, {
        codeChallenge: computeCodeChallenge(verifier),
        codeChallengeMethod: 'S256',
      }),
    );
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });

  it('returns invalid_grant when the verifier does not match the stored challenge', async () => {
    const raw = generateAuthorizationCode();
    const honestVerifier = 'a'.repeat(64);
    const attackerVerifier = 'b'.repeat(64);
    mockFindCode.mockResolvedValue(
      buildCodeRow(raw, {
        codeChallenge: computeCodeChallenge(honestVerifier),
        codeChallengeMethod: 'S256',
      }),
    );
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
        code_verifier: attackerVerifier,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('rejects a public client whose stored code has no challenge (authorize guard bypass defence)', async () => {
    mockFindClient.mockResolvedValue(publicClient);
    const raw = generateAuthorizationCode();
    mockFindCode.mockResolvedValue(
      buildCodeRow(raw, {
        clientId: publicClient.id,
        codeChallenge: null,
        codeChallengeMethod: null,
      }),
    );
    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: publicClient.clientId,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });
});

describe('handleOauthToken — IP binding', () => {
  beforeEach(() => {
    mockFindClient.mockResolvedValue(fixtureClient);
  });

  it('rejects a confidential-client exchange from a different IP than authorize', async () => {
    const raw = generateAuthorizationCode();
    mockFindCode.mockResolvedValue(buildCodeRow(raw, { ipBoundTo: '1.2.3.4' }));
    const res = await handleOauthToken(
      { ...deps, ip: '9.9.9.9' },
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('skips the IP check for public clients (mobile → desktop flows)', async () => {
    mockFindClient.mockResolvedValue(publicClient);
    const raw = generateAuthorizationCode();
    const verifier = 'a'.repeat(64);
    mockFindCode.mockResolvedValue(
      buildCodeRow(raw, {
        clientId: publicClient.id,
        ipBoundTo: '1.2.3.4',
        codeChallenge: computeCodeChallenge(verifier),
        codeChallengeMethod: 'S256',
        scope: 'kyc',
      }),
    );
    const res = await handleOauthToken(
      { ...deps, ip: '9.9.9.9' },
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: publicClient.clientId,
        code_verifier: verifier,
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('handleOauthToken — happy path', () => {
  beforeEach(() => {
    mockFindClient.mockResolvedValue(fixtureClient);
  });

  it('returns access_token + id_token for openid scope and stamps consent when none cached', async () => {
    const raw = generateAuthorizationCode();
    mockFindCode.mockResolvedValue(buildCodeRow(raw));
    mockFindConsent.mockResolvedValue(null);

    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Pragma')).toBe('no-cache');

    const body = await res.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // `expandImplicitScopes` bundles `credential` with every `kyc*`
    // scope; the issued token reflects the expanded set.
    expect(body.scope).toBe('credential kyc openid');
    expect(typeof body.id_token).toBe('string');
    // Three base64url-encoded JWT segments.
    expect(body.id_token.split('.').length).toBe(3);

    expect(mockInsertConsent).toHaveBeenCalledTimes(1);
    expect(mockInsertAccessToken).toHaveBeenCalledTimes(1);
  });

  it('skips id_token when openid scope is not present', async () => {
    const raw = generateAuthorizationCode();
    mockFindCode.mockResolvedValue(buildCodeRow(raw, { scope: 'kyc' }));

    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id_token).toBeUndefined();
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('reuses an already-active consent row instead of inserting a duplicate', async () => {
    const raw = generateAuthorizationCode();
    mockFindCode.mockResolvedValue(buildCodeRow(raw));
    mockFindConsent.mockResolvedValue(buildConsent());

    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
      }),
    );
    expect(res.status).toBe(200);
    expect(mockInsertConsent).not.toHaveBeenCalled();
    expect(mockInsertAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe('handleOauthToken — atomic burn + mint', () => {
  // These two tests pin the "burn never happens until the mint
  // is about to succeed" contract. The handler used to burn the
  // code BEFORE verifying PKCE / binding IP / inserting the
  // token, so any failure on those paths would leave the code
  // stamped `used_at` but no token issued. A legitimate retry
  // then tripped `oauth.code_reuse_detected` — a false-positive
  // security alarm. The fix:
  //
  //   - PKCE + IP checks run BEFORE the burn (pure compute, no
  //     DB mutation).
  //   - burn + consent + insertAccessToken run inside a single
  //     transaction so an `insertAccessToken` failure rolls the
  //     burn back.

  beforeEach(() => {
    mockFindClient.mockResolvedValue(fixtureClient);
  });

  it('does NOT burn the code when PKCE verification fails', async () => {
    const raw = generateAuthorizationCode();
    // Real verifier: `verifier`. The test sends a different one.
    const verifier = 'A'.repeat(43);
    mockFindCode.mockResolvedValue(
      buildCodeRow(raw, {
        codeChallenge: computeCodeChallenge(verifier),
        codeChallengeMethod: 'S256',
      }),
    );

    const res = await handleOauthToken(
      deps,
      buildTokenRequest({
        grant_type: 'authorization_code',
        code: raw,
        redirect_uri: REDIRECT_URI,
        client_id: fixtureClient.clientId,
        client_secret: RAW_SECRET,
        // Wrong verifier — same length so the shape gate passes
        // and the actual hash compare fails.
        code_verifier: 'Z'.repeat(43),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_grant');

    // The critical assertion: the code was NEVER burned. A
    // retry with the correct verifier goes through the normal
    // path — no false `code_reuse_detected` alarm.
    expect(mockBurnCode).not.toHaveBeenCalled();
    expect(mockInsertAccessToken).not.toHaveBeenCalled();
    expect(mockRevokeTokens).not.toHaveBeenCalled();
  });

  it('does NOT trigger a code-reuse cascade when insertAccessToken throws mid-TX', async () => {
    const raw = generateAuthorizationCode();
    mockFindCode.mockResolvedValue(buildCodeRow(raw));
    mockFindConsent.mockResolvedValue(buildConsent());
    // Simulate a transient DB failure on the token write. In
    // production the TX rolls back — the mock TX cannot model
    // rollback directly, but we assert the two structural
    // guarantees it enables:
    //   - `revokeTokensMintedFromCode` is never called (no
    //     false-positive reuse alarm downstream),
    //   - the error propagates so the caller sees a 5xx and
    //     can retry.
    mockInsertAccessToken.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      handleOauthToken(
        deps,
        buildTokenRequest({
          grant_type: 'authorization_code',
          code: raw,
          redirect_uri: REDIRECT_URI,
          client_id: fixtureClient.clientId,
          client_secret: RAW_SECRET,
        }),
      ),
    ).rejects.toThrow('connection reset');

    // burn ran inside the TX — prod rolls it back. The audit-
    // level guarantee we care about: no cascade + no alarm.
    expect(mockRevokeTokens).not.toHaveBeenCalled();
    expect(mockBurnCode).toHaveBeenCalledTimes(1);
    expect(mockInsertAccessToken).toHaveBeenCalledTimes(1);
  });
});
