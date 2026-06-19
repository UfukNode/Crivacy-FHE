// @vitest-environment node
/**
 * OAuth /authorize handler tests.
 *
 * Covers the gatekeeper rules before an authorization request is
 * persisted:
 *   - Unknown client_id or mismatched redirect_uri → static error
 *     page (NEVER redirect — the target isn't trusted).
 *   - Wrong response_type → redirect with unsupported_response_type.
 *   - Scope outside client allowlist → redirect with invalid_scope.
 *   - Public client missing PKCE → redirect with invalid_request.
 *
 * The handler is independent of the app-route middleware chain, so
 * we build a plain NextRequest and mock the two repo functions it
 * calls.
 */

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';
import type { OauthClient } from '@/lib/db/schema/oauth-clients';
import { handleOauthAuthorize } from '@/server/handlers/oauth-authorize';
import * as repos from '@/server/repositories';

vi.mock('@/server/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof repos>();
  return {
    ...actual,
    findOauthClientByClientId: vi.fn(),
    insertAuthorizationRequest: vi.fn(),
  };
});

// Import via `import * as` so the module keeps its default
// fail-open behaviour for every case that doesn't explicitly
// override it — the per-IP cap test overrides `allowed: false`
// while the happy-path cases let the real enforce-try/catch
// fall through to allow.
import * as authRateLimit from '@/lib/auth-rate-limit';
vi.mock('@/lib/auth-rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof authRateLimit>();
  return {
    ...actual,
    enforceAuthRateLimit: vi.fn(async () => ({
      allowed: true,
      retryAfterSeconds: 0,
      attempts: 0,
      max: 30,
    })),
  };
});

const mockFindClient = vi.mocked(repos.findOauthClientByClientId);
const mockInsertRequest = vi.mocked(repos.insertAuthorizationRequest);
const mockEnforceRateLimit = vi.mocked(authRateLimit.enforceAuthRateLimit);

const FIXTURE_NOW = new Date('2026-04-17T12:00:00.000Z');
const FIXTURE_CLIENT: OauthClient = {
  id: 'c1111111-1111-4111-8111-111111111111',
  firmId: 'f1111111-1111-4111-8111-111111111111',
  clientId: 'crv_oauth_live_fixture_client_id_abcd',
  clientSecretHash: '$argon2id$v=19$m=65536,t=3,p=4$salt$hash',
  name: 'Fixture Client',
  description: null,
  logoUrl: null,
  homepageUrl: null,
  redirectUris: ['https://firm.example.com/oauth/callback'],
  allowedScopes: ['openid', 'kyc', 'credential'],
  isPublicClient: false,
  consentTtlDays: 90,
  metadata: {},
  createdByFirmUserId: null,
  failedSecretAttempts: 0,
  secretLockedUntil: null,
  revokedAt: null,
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW,
};

const publicFixture: OauthClient = {
  ...FIXTURE_CLIENT,
  id: 'c2222222-2222-4222-8222-222222222222',
  clientId: 'crv_oauth_live_public_spa____abcd',
  clientSecretHash: null,
  isPublicClient: true,
};

function buildAuthorizeRequest(query: Record<string, string>): NextRequest {
  const url = new URL('https://app.crivacy.test/api/v1/oauth/authorize');
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  // Every test case in this file asserts the happy-path flow for an
  // already-authenticated customer: `/authorize` -> `/oauth/consent`.
  // The new server-side auth gate in the handler routes unauthed
  // users to `/login` instead; the scenario where that bounce fires
  // is covered in its own dedicated case below. So the default
  // request carries the customer access cookie.
  return new NextRequest(
    new Request(url.toString(), {
      method: 'GET',
      headers: { Cookie: `__crivacy_ct=fixture-access-token` },
    }),
  );
}

const deps = {
  db: { _tag: 'mock' } as unknown as CrivacyDatabase,
  now: FIXTURE_NOW,
  ip: '203.0.113.5',
  userAgent: 'test/1.0',
};

beforeEach(() => {
  mockFindClient.mockReset();
  mockInsertRequest.mockReset();
  // Restore the default "allowed" rate-limit decision for every case.
  // The rate-limit test below overrides this explicitly.
  mockEnforceRateLimit.mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
    attempts: 0,
    max: 30,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleOauthAuthorize — untrusted-error branches', () => {
  it('renders a static HTML error when client_id is missing', async () => {
    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'code',
        scope: 'openid',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(mockInsertRequest).not.toHaveBeenCalled();
  });

  it('renders a static HTML error when the client is unknown', async () => {
    mockFindClient.mockResolvedValue(null);
    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: 'crv_oauth_live_unknown_________a',
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'code',
        scope: 'openid',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
    // MUST NOT redirect — attacker-controlled target.
    expect(res.headers.get('location')).toBeNull();
  });

  it('renders a static HTML error on redirect_uri mismatch (no open redirect)', async () => {
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);
    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: FIXTURE_CLIENT.clientId,
        redirect_uri: 'https://attacker.example.com/steal',
        response_type: 'code',
        scope: 'openid',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('location')).toBeNull();
    expect(mockInsertRequest).not.toHaveBeenCalled();
  });

  it('renders a static HTML error on redirect_uri fragment attempts', async () => {
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);
    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: FIXTURE_CLIENT.clientId,
        redirect_uri: 'https://firm.example.com/oauth/callback#injected',
        response_type: 'code',
        scope: 'openid',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('handleOauthAuthorize — redirect-with-error branches', () => {
  it('response_type != code → redirect with unsupported_response_type', async () => {
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);
    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: FIXTURE_CLIENT.clientId,
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'token',
        scope: 'openid',
        state: 'xyz123',
      }),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('unsupported_response_type');
    expect(loc.searchParams.get('state')).toBe('xyz123');
    expect(mockInsertRequest).not.toHaveBeenCalled();
  });

  it('unknown scope → redirect with invalid_scope', async () => {
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);
    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: FIXTURE_CLIENT.clientId,
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'code',
        scope: 'openid nonsense',
      }),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_scope');
  });

  it('scope outside client allowlist → redirect with invalid_scope', async () => {
    // FIXTURE_CLIENT.allowedScopes does NOT include kyc:scores.
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);
    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: FIXTURE_CLIENT.clientId,
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'code',
        scope: 'openid kyc:scores',
      }),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_scope');
    expect(loc.searchParams.get('error_description')).toContain('kyc:scores');
    expect(mockInsertRequest).not.toHaveBeenCalled();
  });

  it('public client without PKCE → redirect with invalid_request', async () => {
    mockFindClient.mockResolvedValue(publicFixture);
    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: publicFixture.clientId,
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'code',
        scope: 'openid',
      }),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('error_description')).toContain('PKCE');
    expect(mockInsertRequest).not.toHaveBeenCalled();
  });

  it('malformed code_challenge → redirect with pkce_invalid', async () => {
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);
    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: FIXTURE_CLIENT.clientId,
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'code',
        scope: 'openid',
        code_challenge: 'too-short',
        code_challenge_method: 'S256',
      }),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('pkce_invalid');
    expect(mockInsertRequest).not.toHaveBeenCalled();
  });

  it('non-S256 code_challenge_method → redirect with pkce_invalid', async () => {
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);
    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: FIXTURE_CLIENT.clientId,
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'code',
        scope: 'openid',
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'plain',
      }),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('pkce_invalid');
  });
});

describe('handleOauthAuthorize — happy path', () => {
  it('persists a request and redirects to /oauth/consent with a fresh request id', async () => {
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);
    mockInsertRequest.mockResolvedValue(undefined as never);

    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: FIXTURE_CLIENT.clientId,
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'code',
        scope: 'openid kyc',
        state: 'csrf-token-42',
        nonce: 'n-0S6_WzA2Mj',
      }),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/oauth/consent');
    expect(loc.searchParams.get('request')?.length).toBeGreaterThan(20);
    expect(mockInsertRequest).toHaveBeenCalledTimes(1);
    const insertedArgs = mockInsertRequest.mock.calls[0]![1];
    expect(insertedArgs.clientId).toBe(FIXTURE_CLIENT.id);
    expect(insertedArgs.state).toBe('csrf-token-42');
    expect(insertedArgs.nonce).toBe('n-0S6_WzA2Mj');
    expect(insertedArgs.ip).toBe('203.0.113.5');
  });

  it('confidential client may omit PKCE (no enforcement for server-side clients)', async () => {
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);
    mockInsertRequest.mockResolvedValue(undefined as never);

    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: FIXTURE_CLIENT.clientId,
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'code',
        scope: 'openid',
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/oauth/consent');
  });

  it('returns a 429 HTML page with Retry-After when the per-IP rate limit trips', async () => {
    // Unknown-client test path needs mockFindClient to resolve null
    // in the usual flow, but the rate-limit gate runs BEFORE client
    // lookup. Set both anyway so the assertion stays focused on the
    // 429 short-circuit — the handler must never touch the DB when
    // the limit already denied the caller.
    mockEnforceRateLimit.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 42,
      attempts: 31,
      max: 30,
    });
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);

    const res = await handleOauthAuthorize(
      deps,
      buildAuthorizeRequest({
        client_id: FIXTURE_CLIENT.clientId,
        redirect_uri: 'https://firm.example.com/oauth/callback',
        response_type: 'code',
        scope: 'openid',
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    // Short-circuit runs before any DB work — no client lookup, no
    // authorize-request insert.
    expect(mockFindClient).not.toHaveBeenCalled();
    expect(mockInsertRequest).not.toHaveBeenCalled();
  });

  it('redirects unauthenticated users straight to /login (no skeleton flash)', async () => {
    mockFindClient.mockResolvedValue(FIXTURE_CLIENT);
    mockInsertRequest.mockResolvedValue(undefined as never);

    // Build the request WITHOUT the customer access cookie. The
    // handler should still persist the authorization_request (so
    // the continue URL works after login) but route the browser to
    // `/login?from=/oauth/consent?request=…` instead of flashing
    // the empty consent skeleton.
    const url = new URL('https://app.crivacy.test/api/v1/oauth/authorize');
    url.searchParams.set('client_id', FIXTURE_CLIENT.clientId);
    url.searchParams.set('redirect_uri', 'https://firm.example.com/oauth/callback');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid');
    const unauthedRequest = new NextRequest(
      new Request(url.toString(), { method: 'GET' }),
    );

    const res = await handleOauthAuthorize(deps, unauthedRequest);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/login');
    const from = loc.searchParams.get('from');
    expect(from).not.toBeNull();
    expect(from!.startsWith('/oauth/consent?request=')).toBe(true);
    // The authorization_request row still lands — the user just
    // visits `/login` on the way to the consent page.
    expect(mockInsertRequest).toHaveBeenCalledTimes(1);
  });
});
