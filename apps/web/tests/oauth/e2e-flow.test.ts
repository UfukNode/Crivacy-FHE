// @vitest-environment node
/**
 * End-to-end OAuth flow integration test.
 *
 * Drives @crivacy/js-sdk against the actual Next.js handlers with
 * an in-memory repo stub so we exercise the full wire-format
 * agreement between client and server:
 *
 *   SDK.buildAuthorizeUrl → handleOauthAuthorize →
 *     consent handler     → handleOauthToken → SDK.exchangeCode →
 *     handleOauthUserinfo → SDK.getUserinfo
 *
 * No fakes below the handler layer — the repo stub stores rows in
 * a plain Map and lets each handler's read/write hit the map. That
 * means if the server emits a PKCE challenge the client can't
 * reproduce, or if the token handler fails to honour redirect_uri
 * byte-match, the test fails. These are the gaps unit tests can't
 * catch.
 */

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OauthAuthorizationCode } from '@/lib/db/schema/oauth-authorization-codes';
import type { OauthAuthorizationRequest } from '@/lib/db/schema/oauth-authorization-requests';
import type { OauthClient } from '@/lib/db/schema/oauth-clients';
import type { OauthConsent } from '@/lib/db/schema/oauth-consents';
import type { OauthAccessToken } from '@/lib/db/schema/oauth-access-tokens';
import { hashAuthorizationCode, hashClientSecret, hashAccessToken } from '@/lib/oauth';
import { handleOauthAuthorize } from '@/server/handlers/oauth-authorize';
import { handleOauthConsentDecision } from '@/server/handlers/oauth-consent';
import { handleOauthToken } from '@/server/handlers/oauth-token';
import { handleOauthUserinfo } from '@/server/handlers/oauth-userinfo';
import * as oauthShared from '@/server/handlers/oauth-shared';
import * as repos from '@/server/repositories';

import { CrivacyClient } from '../../../../packages/js-sdk/src';

// ---------------------------------------------------------------------------
// In-memory repo state
// ---------------------------------------------------------------------------

interface RepoState {
  client: OauthClient;
  authRequests: Map<string, OauthAuthorizationRequest>;
  consents: Map<string, OauthConsent>;
  authCodes: Map<string, OauthAuthorizationCode>;
  accessTokens: Map<string, OauthAccessToken>;
}

let state: RepoState;
const USER_ID = 'd1111111-1111-4111-8111-111111111111';
const FIRM_ID = 'f1111111-1111-4111-8111-111111111111';
const CLIENT_UUID = 'c1111111-1111-4111-8111-111111111111';
const REDIRECT_URI = 'https://firm.example.com/oauth/callback';
const CLIENT_ID_STR = 'crv_oauth_live_fixture_client_id_abcd';
const CLIENT_SECRET = 'confidential-raw-secret-value-aabbcc';

function buildClientRow(overrides: Partial<OauthClient> = {}): OauthClient {
  return {
    id: CLIENT_UUID,
    firmId: FIRM_ID,
    clientId: CLIENT_ID_STR,
    clientSecretHash: null,
    name: 'Fixture Client',
    description: null,
    logoUrl: null,
    homepageUrl: null,
    redirectUris: [REDIRECT_URI],
    allowedScopes: ['openid', 'kyc', 'credential'],
    isPublicClient: false,
    consentTtlDays: 90,
    metadata: {},
    createdByFirmUserId: null,
    failedSecretAttempts: 0,
    secretLockedUntil: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Mock the repositories to back their reads and writes with `state`.
vi.mock('@/server/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof repos>();
  return {
    ...actual,
    findOauthClientByClientId: vi.fn(async (_db, clientIdStr: string) => {
      if (state.client.clientId === clientIdStr && state.client.revokedAt === null) {
        return state.client;
      }
      return null;
    }),
    insertAuthorizationRequest: vi.fn(async (_db, input: Parameters<typeof repos.insertAuthorizationRequest>[1]) => {
      const now = new Date();
      const row: OauthAuthorizationRequest = {
        id: `auth-req-${state.authRequests.size}`,
        requestId: input.requestId,
        clientId: input.clientId,
        // The real handler now persists the authenticated customer id
        // when the /authorize caller already holds a session cookie;
        // null when the request is minted anonymously. Mirror the
        // payload so the ownership gate sees what production sees.
        userId: input.userId,
        redirectUri: input.redirectUri,
        scope: input.scope,
        state: input.state,
        nonce: input.nonce,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        uiLocales: input.uiLocales,
        ip: input.ip,
        userAgent: input.userAgent,
        completedAt: null,
        expiresAt: input.expiresAt,
        createdAt: now,
      } as OauthAuthorizationRequest;
      state.authRequests.set(input.requestId, row);
    }),
    findAuthorizationRequest: vi.fn(async (_db, requestId: string) => {
      return state.authRequests.get(requestId) ?? null;
    }),
    attachUserToAuthorizationRequest: vi.fn(async (_db, requestId: string, userId: string) => {
      // Mirrors the production `UPDATE … WHERE user_id IS NULL
      // RETURNING` contract: returns `true` only when this call
      // actually flipped the column, `false` when the row is missing
      // or already bound to a different (or the same) user. The
      // ownership helper gates mutations on that boolean.
      const row = state.authRequests.get(requestId);
      if (row === undefined || row.userId !== null) return false;
      state.authRequests.set(requestId, { ...row, userId });
      return true;
    }),
    markAuthorizationRequestCompleted: vi.fn(async (_db, requestId: string, now: Date) => {
      // Mirrors the production `UPDATE … WHERE completed_at IS NULL
      // RETURNING` contract: returns `true` only when this call
      // flipped the flag, `false` when the row was already completed
      // (or missing). The consent handler gates its mutations on
      // this boolean, so returning truthy is required for every
      // legitimate flow and returning falsy is what race-loss tests
      // would override.
      const row = state.authRequests.get(requestId);
      if (row === undefined || row.completedAt !== null) return false;
      state.authRequests.set(requestId, { ...row, completedAt: now });
      return true;
    }),
    findActiveConsent: vi.fn(async (_db, userId: string, clientId: string, scopeHash: string, now: Date) => {
      for (const c of state.consents.values()) {
        if (
          c.userId === userId &&
          c.clientId === clientId &&
          c.scopeHash === scopeHash &&
          c.revokedAt === null &&
          c.expiresAt.getTime() > now.getTime()
        ) {
          return c;
        }
      }
      return null;
    }),
    insertConsent: vi.fn(async (_db, input: Parameters<typeof repos.insertConsent>[1]) => {
      // Synthesise a deterministic UUID so the audit/target validators
      // (which enforce UUID v4 shape) stay happy in-test.
      const n = state.consents.size.toString(16).padStart(8, '0');
      const row: OauthConsent = {
        id: `${n}-1111-4111-8111-111111111111`,
        userId: input.userId,
        clientId: input.clientId,
        scope: input.scope,
        scopeHash: input.scopeHash,
        grantedAt: input.grantedAt,
        expiresAt: input.expiresAt,
        revokedAt: null,
        revokedReason: null,
        lastUsedAt: null,
      };
      state.consents.set(row.id, row);
      return row;
    }),
    insertAuthorizationCode: vi.fn(async (_db, input: Parameters<typeof repos.insertAuthorizationCode>[1]) => {
      const row: OauthAuthorizationCode = {
        codeHash: input.codeHash,
        clientId: input.clientId,
        userId: input.userId,
        scope: input.scope,
        redirectUri: input.redirectUri,
        nonce: input.nonce,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        ipBoundTo: input.ipBoundTo,
        usedAt: null,
        expiresAt: input.expiresAt,
        createdAt: new Date(),
      };
      state.authCodes.set(input.codeHash, row);
    }),
    findAuthorizationCode: vi.fn(async (_db, codeHash: string) => {
      return state.authCodes.get(codeHash) ?? null;
    }),
    burnAuthorizationCode: vi.fn(async (_db, codeHash: string, now: Date) => {
      const row = state.authCodes.get(codeHash);
      if (row === undefined || row.usedAt !== null) return false;
      state.authCodes.set(codeHash, { ...row, usedAt: now });
      return true;
    }),
    revokeTokensMintedFromCode: vi.fn(async (_db, codeHash: string, now: Date, reason: string) => {
      for (const [h, t] of state.accessTokens) {
        if (t.authorizationCodeHash === codeHash && t.revokedAt === null) {
          state.accessTokens.set(h, { ...t, revokedAt: now, revokedReason: reason });
        }
      }
    }),
    insertAccessToken: vi.fn(async (_db, input: Parameters<typeof repos.insertAccessToken>[1]) => {
      const row: OauthAccessToken = {
        tokenHash: input.tokenHash,
        clientId: input.clientId,
        userId: input.userId,
        consentId: input.consentId,
        authorizationCodeHash: input.authorizationCodeHash,
        scope: input.scope,
        expiresAt: input.expiresAt,
        revokedAt: null,
        revokedReason: null,
        lastUsedAt: null,
        createdAt: new Date(),
      };
      state.accessTokens.set(input.tokenHash, row);
    }),
    findAccessToken: vi.fn(async (_db, tokenHash: string) => {
      return state.accessTokens.get(tokenHash) ?? null;
    }),
    touchAccessToken: vi.fn(async (_db, tokenHash: string, now: Date) => {
      const row = state.accessTokens.get(tokenHash);
      if (row !== undefined) {
        state.accessTokens.set(tokenHash, { ...row, lastUsedAt: now });
      }
    }),
    // Webhook fan-out stubs — let dispatchOauthConsentEvent run
    // without hitting the real webhook_events/deliveries schema.
    createWebhookEvent: vi.fn(async () => ({ id: 'evt-1' }) as never),
    findEndpointsForEvent: vi.fn(async () => []),
    createDelivery: vi.fn(async () => undefined),
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
    findActiveCredentialForUser: vi.fn(async () => ({
      identityVerified: true,
      livenessVerified: true,
      addressVerified: false,
      humanScore: 87,
      proofHash: '0x' + 'a'.repeat(64),
      level: 'enhanced',
      validUntil: new Date('2027-01-01T00:00:00.000Z'),
      validator: 'DiditValidator',
      chainNetwork: 'mainnet',
      chainContractId: 'contract-123',
    })),
  };
});

// The consent handler resolves the client via a raw drizzle select
// against `oauthClients`. Feed that path an in-memory DB stub that
// returns `state.client` for any lookup. The consent approve path
// also wraps its mutations in `db.transaction(cb)` — since the repo
// writers are all mocked above and ignore their `db` argument, the
// shim just runs the callback with itself as the `tx` handle.
const DB: import('@/lib/db/client').CrivacyDatabase = (() => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [state.client],
        }),
      }),
    }),
    transaction: async <T>(
      cb: (tx: import('@/lib/db/client').CrivacyDatabase) => Promise<T>,
    ): Promise<T> => cb(db as unknown as import('@/lib/db/client').CrivacyDatabase),
  };
  return db as unknown as import('@/lib/db/client').CrivacyDatabase;
})();

// ---------------------------------------------------------------------------
// Tiny fetch shim that dispatches into the handlers
// ---------------------------------------------------------------------------

async function shimFetch(url: string, init?: RequestInit): Promise<Response> {
  const target = new URL(url);
  const request = new NextRequest(
    new Request(url, init ?? { method: 'GET' }),
  );
  if (target.pathname === '/api/v1/oauth/token') {
    const res = await handleOauthToken(
      { db: DB, now: new Date(), ip: '203.0.113.5', issuerUrl: 'https://app.crivacy.test' },
      request,
    );
    return new Response(await res.text(), { status: res.status, headers: res.headers });
  }
  if (target.pathname === '/api/v1/oauth/userinfo') {
    const res = await handleOauthUserinfo(
      { db: DB, now: new Date() },
      request,
    );
    return new Response(await res.text(), { status: res.status, headers: res.headers });
  }
  throw new Error(`shimFetch: unrouted path ${target.pathname}`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks();
  state = {
    client: buildClientRow({
      clientSecretHash: await hashClientSecret(CLIENT_SECRET),
    }),
    authRequests: new Map(),
    consents: new Map(),
    authCodes: new Map(),
    accessTokens: new Map(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Memory storage for the SDK — sessionStorage isn't available in
// the node test env.
function buildSdkStorage() {
  const memory = new Map<string, string>();
  return {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memory.set(k, v);
    },
    removeItem: (k: string) => {
      memory.delete(k);
    },
  };
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

describe('OAuth end-to-end — SDK ↔ server wire format', () => {
  it('drives authorize → consent → token → userinfo with full round-trip', async () => {
    const sdk = new CrivacyClient(
      {
        issuer: 'https://app.crivacy.test',
        clientId: CLIENT_ID_STR,
        redirectUri: REDIRECT_URI,
        clientSecret: CLIENT_SECRET,
        fetch: shimFetch as unknown as typeof fetch,
      },
      buildSdkStorage(),
    );

    // 1. Client builds the authorize URL with PKCE + state.
    const built = await sdk.buildAuthorizeUrl({ scope: ['openid', 'kyc', 'credential'] });

    // 2. Server consumes the URL directly (no browser).
    const authorizeReq = new NextRequest(
      new Request(built.url, {
        method: 'GET',
        // The handler now redirects unauthenticated users to `/login`.
        // E2E covers the post-auth happy path, so we send the customer
        // access cookie with every authorize request; the unauth bounce
        // is covered in `tests/oauth/authorize.test.ts`.
        headers: { Cookie: '__crivacy_ct=fixture-access-token' },
      }),
    );
    const authorizeRes = await handleOauthAuthorize(
      { db: DB, now: new Date(), ip: '203.0.113.5', userAgent: 'e2e/1.0' },
      authorizeReq,
    );
    expect(authorizeRes.status).toBe(302);
    const nextUrl = new URL(authorizeRes.headers.get('location')!);
    expect(nextUrl.pathname).toBe('/oauth/consent');
    const requestId = nextUrl.searchParams.get('request');
    expect(requestId).not.toBeNull();

    // 3. User approves — the consent handler mints the code and
    //    redirects back to the firm with ?code=…&state=…
    const consentResult = await handleOauthConsentDecision(
      {
        db: DB,
        now: new Date(),
        ip: '203.0.113.5',
        customerLabel: 'e2e@example.com',
        userAgent: 'e2e/1.0',
        requestAuditId: 'ecb7b22d-2cc3-4444-8abc-010101010101',
      },
      { requestId: requestId!, userId: USER_ID, decision: 'approve' },
    );
    const callbackUrl = new URL(consentResult.redirectUrl);
    expect(callbackUrl.searchParams.get('state')).toBe(built.state);
    expect(callbackUrl.searchParams.get('code')).not.toBeNull();

    // 4. SDK's handleCallback validates state and hands back the code.
    const callback = await sdk.handleCallback(callbackUrl);
    expect(callback.state).toBe(built.state);
    expect(callback.codeVerifier).toBe(built.codeVerifier);

    // 5. SDK exchanges the code for tokens via the shim.
    const tokens = await sdk.exchangeCode({
      code: callback.code,
      codeVerifier: callback.codeVerifier,
    });
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.id_token?.split('.').length).toBe(3);
    expect(tokens.scope).toBe('credential kyc openid');
    // The code row should be marked as used so a replay would fail.
    const codeRow = state.authCodes.get(hashAuthorizationCode(callback.code));
    expect(codeRow?.usedAt).not.toBeNull();

    // 6. userinfo call returns the claim set matching the scope.
    const claims = await sdk.getUserinfo(tokens.access_token);
    expect(claims.sub).toBe(USER_ID);
    expect(claims.identity_verified).toBe(true);
    expect(claims.liveness_verified).toBe(true);
    expect(claims.credential_proof_hash).toBe('0x' + 'a'.repeat(64));
    // kyc:scores was not in the scope — no humanity_score.
    expect(claims.humanity_score).toBeUndefined();
    // Access token was touched (last_used_at set).
    const tokenRow = state.accessTokens.get(hashAccessToken(tokens.access_token));
    expect(tokenRow?.lastUsedAt).not.toBeNull();
  });

  it('code replay against /token triggers the reuse defence', async () => {
    const sdk = new CrivacyClient(
      {
        issuer: 'https://app.crivacy.test',
        clientId: CLIENT_ID_STR,
        redirectUri: REDIRECT_URI,
        clientSecret: CLIENT_SECRET,
        fetch: shimFetch as unknown as typeof fetch,
      },
      buildSdkStorage(),
    );

    const built = await sdk.buildAuthorizeUrl({ scope: ['openid', 'kyc'] });
    const authorizeReq = new NextRequest(
      new Request(built.url, {
        method: 'GET',
        // The handler now redirects unauthenticated users to `/login`.
        // E2E covers the post-auth happy path, so we send the customer
        // access cookie with every authorize request; the unauth bounce
        // is covered in `tests/oauth/authorize.test.ts`.
        headers: { Cookie: '__crivacy_ct=fixture-access-token' },
      }),
    );
    const authorizeRes = await handleOauthAuthorize(
      { db: DB, now: new Date(), ip: '203.0.113.5', userAgent: 'e2e/1.0' },
      authorizeReq,
    );
    const requestId = new URL(authorizeRes.headers.get('location')!).searchParams.get('request')!;
    const consentResult = await handleOauthConsentDecision(
      {
        db: DB,
        now: new Date(),
        ip: '203.0.113.5',
        customerLabel: 'e2e@example.com',
        userAgent: 'e2e/1.0',
        requestAuditId: 'ecb7b22d-2cc3-4444-8abc-010101010101',
      },
      { requestId, userId: USER_ID, decision: 'approve' },
    );
    const callback = await sdk.handleCallback(new URL(consentResult.redirectUrl));

    // First exchange — success.
    const tokens = await sdk.exchangeCode({
      code: callback.code,
      codeVerifier: callback.codeVerifier,
    });
    expect(tokens.access_token.length).toBeGreaterThan(0);

    // Same SDK instance would have cleared the verifier, so rebuild
    // one that still has it — mirrors an attacker who captured the
    // (code, verifier) pair after the honest exchange.
    const replayerSdk = new CrivacyClient(
      {
        issuer: 'https://app.crivacy.test',
        clientId: CLIENT_ID_STR,
        redirectUri: REDIRECT_URI,
        clientSecret: CLIENT_SECRET,
        fetch: shimFetch as unknown as typeof fetch,
      },
      buildSdkStorage(),
    );
    await expect(
      replayerSdk.exchangeCode({ code: callback.code, codeVerifier: callback.codeVerifier }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    // The token minted from the replayed code must now be revoked
    // (RFC 9700 §2.1.1 code-reuse mitigation).
    const tokenRow = state.accessTokens.get(hashAccessToken(tokens.access_token));
    expect(tokenRow?.revokedAt).not.toBeNull();
    expect(tokenRow?.revokedReason).toBe('code_reuse_detected');
  });

  it('reject path returns access_denied to the firm without minting a code', async () => {
    const sdk = new CrivacyClient(
      {
        issuer: 'https://app.crivacy.test',
        clientId: CLIENT_ID_STR,
        redirectUri: REDIRECT_URI,
        clientSecret: CLIENT_SECRET,
        fetch: shimFetch as unknown as typeof fetch,
      },
      buildSdkStorage(),
    );

    const built = await sdk.buildAuthorizeUrl({ scope: ['openid', 'kyc'] });
    const authorizeReq = new NextRequest(
      new Request(built.url, {
        method: 'GET',
        // The handler now redirects unauthenticated users to `/login`.
        // E2E covers the post-auth happy path, so we send the customer
        // access cookie with every authorize request; the unauth bounce
        // is covered in `tests/oauth/authorize.test.ts`.
        headers: { Cookie: '__crivacy_ct=fixture-access-token' },
      }),
    );
    const authorizeRes = await handleOauthAuthorize(
      { db: DB, now: new Date(), ip: '203.0.113.5', userAgent: 'e2e/1.0' },
      authorizeReq,
    );
    const requestId = new URL(authorizeRes.headers.get('location')!).searchParams.get('request')!;

    const consentResult = await handleOauthConsentDecision(
      {
        db: DB,
        now: new Date(),
        ip: '203.0.113.5',
        customerLabel: 'e2e@example.com',
        userAgent: 'e2e/1.0',
        requestAuditId: 'ecb7b22d-2cc3-4444-8abc-010101010101',
      },
      { requestId, userId: USER_ID, decision: 'reject' },
    );
    await expect(sdk.handleCallback(new URL(consentResult.redirectUrl))).rejects.toMatchObject({
      code: 'access_denied',
    });
    expect(state.authCodes.size).toBe(0);
    expect(state.accessTokens.size).toBe(0);
  });

  it('state echo survives a unicode/CRLF-injection attempt without breaking the URL', async () => {
    const sdk = new CrivacyClient(
      {
        issuer: 'https://app.crivacy.test',
        clientId: CLIENT_ID_STR,
        redirectUri: REDIRECT_URI,
        clientSecret: CLIENT_SECRET,
        fetch: shimFetch as unknown as typeof fetch,
      },
      buildSdkStorage(),
    );
    const built = await sdk.buildAuthorizeUrl({ scope: ['openid', 'kyc'] });

    // Hand-patch the state value to something nasty. Mirrors an
    // attacker who hijacks the authorize URL and swaps in a CRLF
    // string hoping it leaks into response headers. URLSearchParams
    // encodes it, so the returned location header must remain a
    // syntactically valid redirect.
    const evilState = 'abc\r\nSet-Cookie: stolen=1';
    const url = new URL(built.url);
    url.searchParams.set('state', evilState);
    const authorizeRes = await handleOauthAuthorize(
      { db: DB, now: new Date(), ip: '203.0.113.5', userAgent: 'e2e/1.0' },
      new NextRequest(new Request(url.toString(), { method: 'GET' })),
    );
    expect(authorizeRes.status).toBe(302);
    const loc = authorizeRes.headers.get('location')!;
    // No actual newline in the location header value.
    expect(loc.includes('\n')).toBe(false);
    expect(loc.includes('\r')).toBe(false);
  });
});
