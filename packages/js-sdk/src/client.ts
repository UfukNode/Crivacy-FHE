/**
 * {@link CrivacyClient} — the main SDK entry point.
 *
 * Typical browser integration:
 *
 * ```ts
 * const client = new CrivacyClient({
 *   clientId: 'crv_oauth_live_...',
 *   redirectUri: 'https://your.app/oauth/callback',
 * });
 *
 * // On your "Verify with Crivacy" button click:
 * await client.authorize({ scope: ['openid', 'kyc'] });
 *
 * // On your /oauth/callback page:
 * const result = await client.handleCallback();
 * // send result.code + result.codeVerifier to your backend,
 * // never exchange tokens from the browser.
 * ```
 *
 * Typical backend code-exchange:
 *
 * ```ts
 * const client = new CrivacyClient({
 *   clientId: process.env.CRIVACY_CLIENT_ID,
 *   clientSecret: process.env.CRIVACY_CLIENT_SECRET,
 *   redirectUri: 'https://your.app/oauth/callback',
 * });
 *
 * const tokens = await client.exchangeCode({ code, codeVerifier });
 * const claims = await client.getUserinfo(tokens.access_token);
 * ```
 *
 * @module
 */

import { CrivacyOauthError, type CrivacyOauthErrorCode } from './errors';
import {
  computeCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from './pkce';
import {
  clearAuthorizationRequest,
  createDefaultStorage,
  persistAuthorizationRequest,
  readAuthorizationRequest,
  type SdkStorage,
} from './storage';
import type {
  AuthorizeOptions,
  AuthorizeUrl,
  CallbackResult,
  CrivacyClaims,
  CrivacyClientOptions,
  TokenResponse,
} from './types';

const DEFAULT_ISSUER = 'https://app.crivacy.io';
const KNOWN_SERVER_ERRORS: ReadonlySet<CrivacyOauthErrorCode> = new Set([
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'invalid_grant',
  'invalid_client',
  'redirect_uri_mismatch',
  'invalid_token',
  'expired_token',
  'consent_required',
  'consent_scope_escalation',
  'pkce_invalid',
  'pkce_required',
]);

export class CrivacyClient {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly defaultRedirectUri: string;
  private readonly clientSecret: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: SdkStorage;

  constructor(options: CrivacyClientOptions, storage?: SdkStorage) {
    if (options.clientId.length === 0) {
      throw new CrivacyOauthError('invalid_request', 'clientId is required.');
    }
    if (options.redirectUri.length === 0) {
      throw new CrivacyOauthError('invalid_request', 'redirectUri is required.');
    }
    this.issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, '');
    this.clientId = options.clientId;
    this.defaultRedirectUri = options.redirectUri;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.storage = storage ?? createDefaultStorage();
  }

  /**
   * Build the full authorize URL and persist the PKCE verifier +
   * state. When `navigate` is true (the default in browsers), also
   * redirects the user — the typical one-liner integration.
   *
   * Server-side / SSR users should pass `{ navigate: false }` and
   * return the URL to the client themselves.
   */
  async buildAuthorizeUrl(options: AuthorizeOptions): Promise<AuthorizeUrl> {
    if (options.scope.length === 0) {
      throw new CrivacyOauthError('invalid_scope', 'At least one scope is required.');
    }
    const redirectUri = options.redirectUri ?? this.defaultRedirectUri;
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(codeVerifier);
    const nonce = options.nonce ?? (options.scope.includes('openid') ? generateNonce() : undefined);

    await persistAuthorizationRequest(this.storage, this.clientId, {
      state,
      codeVerifier,
      redirectUri,
      ...(nonce !== undefined ? { nonce } : {}),
    });

    const url = new URL(`${this.issuer}/api/v1/oauth/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', options.scope.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (nonce !== undefined) url.searchParams.set('nonce', nonce);
    if (options.uiLocales !== undefined) url.searchParams.set('ui_locales', options.uiLocales);

    return nonce !== undefined
      ? { url: url.toString(), state, codeVerifier, nonce }
      : { url: url.toString(), state, codeVerifier };
  }

  /**
   * Browser convenience — {@link buildAuthorizeUrl} + navigate the
   * current tab to the returned URL. Rejects with
   * `storage_unavailable` if storage is broken (private browsing)
   * so the caller can render a recovery page.
   */
  async authorize(options: AuthorizeOptions): Promise<never> {
    const { url } = await this.buildAuthorizeUrl(options);
    if (typeof globalThis.location === 'undefined') {
      throw new CrivacyOauthError(
        'not_a_callback',
        'authorize() navigates the current tab; call buildAuthorizeUrl() server-side instead.',
      );
    }
    globalThis.location.assign(url);
    // Browsers run assign() async; returning never keeps TS happy
    // for callers who `await` the promise. In practice the tab has
    // navigated before any subsequent statement executes.
    return new Promise<never>(() => undefined);
  }

  /**
   * Handle the `/oauth/callback` landing. Parses `code` and `state`
   * from the URL (or from a supplied URL / search string), checks
   * `state` against storage, returns the code + the verifier that
   * was bound to it.
   *
   * Does NOT exchange the code. Forward the returned values to your
   * backend for the token exchange so `client_secret` never leaves
   * your server.
   */
  async handleCallback(input?: string | URL): Promise<CallbackResult> {
    const url = resolveCallbackUrl(input);
    const error = url.searchParams.get('error');
    if (error !== null) {
      const description = url.searchParams.get('error_description');
      const stateEcho = url.searchParams.get('state');
      throw new CrivacyOauthError(
        mapServerError(error),
        description ?? 'Authorize request failed.',
        {
          ...(description !== null ? { description } : {}),
          ...(stateEcho !== null ? { state: stateEcho } : {}),
        },
      );
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code === null || state === null) {
      throw new CrivacyOauthError(
        'not_a_callback',
        'URL is missing code or state — are you on the callback page?',
      );
    }

    const stored = await readAuthorizationRequest(this.storage, this.clientId);
    if (stored === null) {
      throw new CrivacyOauthError(
        'missing_verifier',
        'No pending authorize request found — cleared by another tab or the session expired.',
      );
    }
    if (stored.state !== state) {
      throw new CrivacyOauthError(
        'state_mismatch',
        'state parameter did not match the stored value — possible CSRF attempt.',
      );
    }

    await clearAuthorizationRequest(this.storage, this.clientId);
    return {
      code,
      state,
      codeVerifier: stored.codeVerifier,
      redirectUri: stored.redirectUri,
    };
  }

  /**
   * Server-side: exchange the authorization code for tokens.
   * Public clients may also call this from the browser — the SDK
   * will simply not include `client_secret` in the request body.
   */
  async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri?: string;
  }): Promise<TokenResponse> {
    const redirectUri = input.redirectUri ?? this.defaultRedirectUri;
    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('code', input.code);
    form.set('redirect_uri', redirectUri);
    form.set('client_id', this.clientId);
    form.set('code_verifier', input.codeVerifier);
    if (this.clientSecret !== undefined) {
      form.set('client_secret', this.clientSecret);
    }

    const res = await this.postForm('/api/v1/oauth/token', form);
    return (await res.json()) as TokenResponse;
  }

  /**
   * Fetch the userinfo claim set for an access token.
   */
  async getUserinfo(accessToken: string): Promise<CrivacyClaims> {
    const res = await this.fetchImpl(`${this.issuer}/api/v1/oauth/userinfo`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch((err) => {
      throw new CrivacyOauthError('network_error', 'userinfo request failed.', { cause: err });
    });
    if (!res.ok) {
      await this.throwFromResponse(res);
    }
    return (await res.json()) as CrivacyClaims;
  }

  // ---------------------------------------------------------------------
  // Internal HTTP helpers
  // ---------------------------------------------------------------------

  private async postForm(path: string, body: URLSearchParams): Promise<Response> {
    const res = await this.fetchImpl(`${this.issuer}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }).catch((err) => {
      throw new CrivacyOauthError('network_error', `POST ${path} failed.`, { cause: err });
    });
    if (!res.ok) {
      await this.throwFromResponse(res);
    }
    return res;
  }

  private async throwFromResponse(res: Response): Promise<never> {
    let body: { error?: string; error_description?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Non-JSON error body — surface a generic unknown_error.
    }
    const code = body.error !== undefined ? mapServerError(body.error) : 'unknown_error';
    throw new CrivacyOauthError(
      code,
      body.error_description ?? `Request failed with HTTP ${res.status}.`,
      body.error_description !== undefined ? { description: body.error_description } : {},
    );
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function resolveCallbackUrl(input: string | URL | undefined): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') {
    try {
      return new URL(input);
    } catch {
      // Not a full URL — treat as a query string.
      return new URL(`https://x${input.startsWith('?') ? input : `?${input}`}`);
    }
  }
  if (typeof globalThis.location === 'undefined') {
    throw new CrivacyOauthError(
      'not_a_callback',
      'handleCallback needs a URL or the global location — neither was found.',
    );
  }
  return new URL(globalThis.location.href);
}

function mapServerError(code: string): CrivacyOauthErrorCode {
  if (KNOWN_SERVER_ERRORS.has(code as CrivacyOauthErrorCode)) {
    return code as CrivacyOauthErrorCode;
  }
  return 'unknown_error';
}
