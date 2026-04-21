// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CrivacyClient } from '../src/client';
import { CrivacyOauthError } from '../src/errors';
import type { SdkStorage } from '../src/storage';

function buildMemoryStorage(): SdkStorage {
  const memory = new Map<string, string>();
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => {
      memory.set(k, v);
    },
    removeItem: (k) => {
      memory.delete(k);
    },
  };
}

const CLIENT_OPTIONS = {
  issuer: 'https://app.crivacy.test',
  clientId: 'crv_oauth_live_fixture_client_id_abcd',
  redirectUri: 'https://firm.example.com/cb',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CrivacyClient — constructor validation', () => {
  it('rejects an empty clientId', () => {
    expect(
      () => new CrivacyClient({ ...CLIENT_OPTIONS, clientId: '' }),
    ).toThrow(CrivacyOauthError);
  });

  it('rejects an empty redirectUri', () => {
    expect(
      () => new CrivacyClient({ ...CLIENT_OPTIONS, redirectUri: '' }),
    ).toThrow(CrivacyOauthError);
  });

  it('strips trailing slashes from the issuer', async () => {
    const storage = buildMemoryStorage();
    const client = new CrivacyClient({ ...CLIENT_OPTIONS, issuer: 'https://app.crivacy.test/' }, storage);
    const built = await client.buildAuthorizeUrl({ scope: ['openid'] });
    expect(built.url.startsWith('https://app.crivacy.test/api/v1/oauth/authorize')).toBe(true);
  });
});

describe('CrivacyClient — buildAuthorizeUrl', () => {
  it('includes response_type, client_id, scope, state, PKCE params', async () => {
    const storage = buildMemoryStorage();
    const client = new CrivacyClient(CLIENT_OPTIONS, storage);
    const built = await client.buildAuthorizeUrl({ scope: ['openid', 'kyc'] });
    const url = new URL(built.url);
    expect(url.pathname).toBe('/api/v1/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_OPTIONS.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(CLIENT_OPTIONS.redirectUri);
    expect(url.searchParams.get('scope')).toBe('openid kyc');
    expect(url.searchParams.get('state')).toBe(built.state);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // openid in scope → nonce auto-generated.
    expect(url.searchParams.get('nonce')).toBe(built.nonce);
  });

  it('omits nonce when openid is not requested and none is supplied', async () => {
    const storage = buildMemoryStorage();
    const client = new CrivacyClient(CLIENT_OPTIONS, storage);
    const built = await client.buildAuthorizeUrl({ scope: ['kyc'] });
    expect(new URL(built.url).searchParams.get('nonce')).toBeNull();
    expect(built.nonce).toBeUndefined();
  });

  it('rejects an empty scope list', async () => {
    const client = new CrivacyClient(CLIENT_OPTIONS, buildMemoryStorage());
    await expect(client.buildAuthorizeUrl({ scope: [] })).rejects.toThrow(CrivacyOauthError);
  });

  it('persists state + verifier + redirect to storage under the clientId', async () => {
    const storage = buildMemoryStorage();
    const client = new CrivacyClient(CLIENT_OPTIONS, storage);
    const built = await client.buildAuthorizeUrl({ scope: ['openid'] });
    expect(await storage.getItem(`crivacy.oauth.state.${CLIENT_OPTIONS.clientId}`)).toBe(built.state);
    expect(await storage.getItem(`crivacy.oauth.verifier.${CLIENT_OPTIONS.clientId}`)).toBe(built.codeVerifier);
    expect(await storage.getItem(`crivacy.oauth.redirect.${CLIENT_OPTIONS.clientId}`)).toBe(CLIENT_OPTIONS.redirectUri);
  });
});

describe('CrivacyClient — handleCallback', () => {
  it('validates state against storage and returns code + verifier', async () => {
    const storage = buildMemoryStorage();
    const client = new CrivacyClient(CLIENT_OPTIONS, storage);
    const built = await client.buildAuthorizeUrl({ scope: ['openid', 'kyc'] });
    const callbackUrl = `${CLIENT_OPTIONS.redirectUri}?code=authcode123&state=${built.state}`;
    const result = await client.handleCallback(callbackUrl);
    expect(result.code).toBe('authcode123');
    expect(result.state).toBe(built.state);
    expect(result.codeVerifier).toBe(built.codeVerifier);
    expect(result.redirectUri).toBe(CLIENT_OPTIONS.redirectUri);

    // State + verifier cleared after success (single-use).
    expect(await storage.getItem(`crivacy.oauth.state.${CLIENT_OPTIONS.clientId}`)).toBeNull();
  });

  it('throws state_mismatch when the returned state does not match storage', async () => {
    const storage = buildMemoryStorage();
    const client = new CrivacyClient(CLIENT_OPTIONS, storage);
    await client.buildAuthorizeUrl({ scope: ['openid'] });
    const attackerUrl = `${CLIENT_OPTIONS.redirectUri}?code=c&state=not-the-right-state`;
    await expect(client.handleCallback(attackerUrl)).rejects.toMatchObject({
      code: 'state_mismatch',
    });
  });

  it('throws missing_verifier when storage has no pending request', async () => {
    const storage = buildMemoryStorage();
    const client = new CrivacyClient(CLIENT_OPTIONS, storage);
    const url = `${CLIENT_OPTIONS.redirectUri}?code=c&state=s`;
    await expect(client.handleCallback(url)).rejects.toMatchObject({
      code: 'missing_verifier',
    });
  });

  it('re-throws server-emitted errors preserving the code and state echo', async () => {
    const storage = buildMemoryStorage();
    const client = new CrivacyClient(CLIENT_OPTIONS, storage);
    await client.buildAuthorizeUrl({ scope: ['openid'] });
    const url = `${CLIENT_OPTIONS.redirectUri}?error=access_denied&error_description=User+bailed&state=s`;
    await expect(client.handleCallback(url)).rejects.toMatchObject({
      code: 'access_denied',
      description: 'User bailed',
      state: 's',
    });
  });

  it('throws not_a_callback when code and state are absent and no error is emitted', async () => {
    const storage = buildMemoryStorage();
    const client = new CrivacyClient(CLIENT_OPTIONS, storage);
    await expect(
      client.handleCallback(`${CLIENT_OPTIONS.redirectUri}?foo=bar`),
    ).rejects.toMatchObject({ code: 'not_a_callback' });
  });

  it('maps an unknown server error code to unknown_error (defensive)', async () => {
    const storage = buildMemoryStorage();
    const client = new CrivacyClient(CLIENT_OPTIONS, storage);
    await client.buildAuthorizeUrl({ scope: ['openid'] });
    const url = `${CLIENT_OPTIONS.redirectUri}?error=brand_new_future_code&error_description=huh&state=s`;
    await expect(client.handleCallback(url)).rejects.toMatchObject({
      code: 'unknown_error',
    });
  });
});

describe('CrivacyClient — exchangeCode', () => {
  it('posts form-encoded body with code, verifier, client_id and client_secret', async () => {
    const storage = buildMemoryStorage();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'tok',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid kyc',
          id_token: 'jwt.body.sig',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new CrivacyClient(
      {
        ...CLIENT_OPTIONS,
        clientSecret: 'secret-abc',
        fetch: fetchMock as unknown as typeof fetch,
      },
      storage,
    );
    const tokens = await client.exchangeCode({
      code: 'authcode',
      codeVerifier: 'v'.repeat(64),
    });
    expect(tokens.access_token).toBe('tok');
    expect(fetchMock).toHaveBeenCalledOnce();
    const firstCall = fetchMock.mock.calls[0]!;
    const [urlArg, initArg] = firstCall as [string, RequestInit];
    expect(urlArg).toBe('https://app.crivacy.test/api/v1/oauth/token');
    const body = new URLSearchParams(initArg.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('authcode');
    expect(body.get('code_verifier')).toBe('v'.repeat(64));
    expect(body.get('client_id')).toBe(CLIENT_OPTIONS.clientId);
    expect(body.get('client_secret')).toBe('secret-abc');
  });

  it('omits client_secret for public clients', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"access_token":"tok","token_type":"Bearer","expires_in":3600,"scope":"kyc"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new CrivacyClient(
      { ...CLIENT_OPTIONS, fetch: fetchMock as unknown as typeof fetch },
      buildMemoryStorage(),
    );
    await client.exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(64) });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = new URLSearchParams(init.body as string);
    expect(body.has('client_secret')).toBe(false);
  });

  it('throws the server-emitted OAuth error on non-2xx responses', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Code expired' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new CrivacyClient(
      { ...CLIENT_OPTIONS, fetch: fetchMock as unknown as typeof fetch },
      buildMemoryStorage(),
    );
    await expect(
      client.exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'invalid_grant', description: 'Code expired' });
  });
});

describe('CrivacyClient — getUserinfo', () => {
  it('sends Authorization: Bearer and returns the claim JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ sub: 'u1', identity_verified: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new CrivacyClient(
      { ...CLIENT_OPTIONS, fetch: fetchMock as unknown as typeof fetch },
      buildMemoryStorage(),
    );
    const claims = await client.getUserinfo('access-token');
    expect(claims.sub).toBe('u1');
    expect(claims.identity_verified).toBe(true);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-token');
  });

  it('surfaces invalid_token when the server rejects the bearer', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_token', error_description: 'expired' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new CrivacyClient(
      { ...CLIENT_OPTIONS, fetch: fetchMock as unknown as typeof fetch },
      buildMemoryStorage(),
    );
    await expect(client.getUserinfo('tok')).rejects.toMatchObject({
      code: 'invalid_token',
      description: 'expired',
    });
  });

  it('wraps underlying fetch rejections as network_error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new CrivacyClient(
      { ...CLIENT_OPTIONS, fetch: fetchMock as unknown as typeof fetch },
      buildMemoryStorage(),
    );
    await expect(client.getUserinfo('tok')).rejects.toMatchObject({
      code: 'network_error',
    });
  });
});
