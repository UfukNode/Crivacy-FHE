/**
 * Google OAuth 2.0 — raw fetch, zero dependencies.
 *
 * Flow:
 * 1. `buildGoogleAuthUrl()` → redirect user to Google consent screen
 * 2. Google redirects back with `?code=...&state=...`
 * 3. `exchangeGoogleCode()` → exchange code for tokens
 * 4. `fetchGoogleUserInfo()` → get email, name, sub from Google
 *
 * State parameter is a signed JWT (10-min TTL) containing a random
 * nonce to prevent CSRF. The same nonce is stored in a httpOnly
 * cookie so we can verify on callback.
 *
 * @module
 */

import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

import { safeJwtVerify } from '@/lib/auth/jwt';

import type { CustomerAuthConfig } from './config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoogleUserInfo {
  /** Google's unique user identifier (the "sub" claim). */
  readonly sub: string;
  /** User's email (verified by Google). */
  readonly email: string;
  /** Whether the email is verified on Google's side. */
  readonly emailVerified: boolean;
  /** User's display name (may be empty). */
  readonly name: string;
  /** User's profile picture URL (may be empty). */
  readonly picture: string;
}

export interface GoogleTokens {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly tokenType: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

/** State JWT TTL: 10 minutes. */
const STATE_TTL_SECONDS = 600;

/**
 * Generate a PKCE verifier + matching S256 code-challenge pair.
 * RFC 7636 §4.1: `verifier = high-entropy 43-128 char base64url
 * string`. 32 random bytes → 43 base64url chars (no padding) sits at
 * the spec's lower bound while keeping the resulting URL short.
 *
 * The verifier never leaves the server's signed-JWT payload — it
 * lives in the state token (HS256-signed) until the callback unwraps
 * it and threads it back to Google's `/token` endpoint. This avoids
 * the extra cookie that classic PKCE flows use to persist the
 * verifier across the consent redirect.
 */
function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

/**
 * OAuth flow mode.
 * - `login` — default, for login / registration
 * - `link` — link Google to an existing logged-in customer
 */
export type OAuthMode = 'login' | 'link';

/**
 * Generate a signed state parameter for the OAuth flow.
 * Returns { stateJwt, nonce } — nonce goes into httpOnly cookie,
 * stateJwt goes as the `state` query param.
 *
 * @param mode - 'login' (default) or 'link' (attach Google to existing customer)
 * @param customerId - Required when mode='link'. Embedded in the signed JWT so the
 *   callback can identify the customer without relying on SameSite=Strict cookies
 *   (which are NOT sent on cross-origin redirects from Google).
 */
export async function generateOAuthState(
  jwtSecret: string,
  mode: OAuthMode = 'login',
  customerId?: string,
  continueTo?: string,
): Promise<{ stateJwt: string; nonce: string; codeChallenge: string }> {
  const nonce = randomBytes(16).toString('base64url');
  const { verifier, challenge } = generatePkcePair();
  const secret = new TextEncoder().encode(jwtSecret);

  const payload: Record<string, unknown> = { nonce, mode, pkce: verifier };
  if (mode === 'link' && customerId) {
    payload['cid'] = customerId;
  }
  // `continueTo` is only honoured when the caller passes a
  // same-origin absolute path; the initiate endpoint validates
  // that shape before embedding it. Round-tripping the value
  // through the signed JWT means the callback can trust it
  // without re-reading request state that might not survive the
  // Google cross-origin bounce.
  if (mode === 'login' && typeof continueTo === 'string' && continueTo.length > 0) {
    payload['ct'] = continueTo;
  }

  const stateJwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(secret);

  return { stateJwt, nonce, codeChallenge: challenge };
}

/**
 * Result of verifying an OAuth state JWT.
 */
export interface OAuthStateResult {
  readonly nonce: string;
  readonly mode: OAuthMode;
  /** Customer ID — only present when mode='link'. */
  readonly customerId: string | undefined;
  /**
   * Caller's intended landing path after a successful login.
   * Embedded by the initiate route AFTER a same-origin guard, so
   * this value is safe to use as a redirect target without
   * additional validation. Only populated for `mode === 'login'`.
   */
  readonly continueTo: string | undefined;
  /**
   * PKCE code_verifier (RFC 7636) minted at initiate-time. The
   * matching SHA-256 challenge was sent on the consent URL; Google
   * verifies it against this verifier when the callback exchanges
   * the auth code. Travelling inside the signed JWT keeps the value
   * server-confidential through the cross-origin bounce.
   */
  readonly pkceVerifier: string;
  /**
   * JWT `jti` claim — primary key in `oauth_state_used` for the
   * single-use burn (F-A2-A7-001). Callback claims this immediately
   * after verifying the state so a stolen state+cookie pair cannot
   * replay the callback within the 10-minute TTL.
   */
  readonly jti: string;
  /** JWT `exp` (Unix seconds) — used as the burn-row TTL. */
  readonly expiresAt: Date;
}

/**
 * Verify the state JWT and extract the nonce + mode + customerId.
 * Throws on invalid/expired state, or when the PKCE verifier claim
 * is missing — the latter implies the state was minted by an old
 * build (pre-PKCE rollout) or has been tampered with; either way
 * the safer outcome is "reject the callback".
 */
export async function verifyOAuthState(
  stateJwt: string,
  jwtSecret: string,
): Promise<OAuthStateResult> {
  const secret = new TextEncoder().encode(jwtSecret);
  const { payload } = await safeJwtVerify(stateJwt, secret);
  const nonce = payload['nonce'];
  if (typeof nonce !== 'string') {
    throw new Error('Invalid state: missing nonce');
  }
  const mode = payload['mode'] === 'link' ? 'link' as const : 'login' as const;
  const cid = payload['cid'];
  const customerId = typeof cid === 'string' ? cid : undefined;
  const ct = payload['ct'];
  const continueTo = typeof ct === 'string' ? ct : undefined;
  const pkce = payload['pkce'];
  if (typeof pkce !== 'string' || pkce.length === 0) {
    throw new Error('Invalid state: missing PKCE verifier');
  }
  const jti = payload['jti'];
  if (typeof jti !== 'string' || jti.length === 0) {
    throw new Error('Invalid state: missing jti');
  }
  const exp = payload['exp'];
  if (typeof exp !== 'number') {
    throw new Error('Invalid state: missing exp');
  }
  return {
    nonce,
    mode,
    customerId,
    continueTo,
    pkceVerifier: pkce,
    jti,
    expiresAt: new Date(exp * 1000),
  };
}

// ---------------------------------------------------------------------------
// Auth URL
// ---------------------------------------------------------------------------

/**
 * Build the Google OAuth 2.0 consent screen URL.
 */
export function buildGoogleAuthUrl(
  config: Pick<CustomerAuthConfig, 'googleClientId' | 'googleRedirectUri'>,
  state: string,
  codeChallenge: string,
): string {
  // Scope is intentionally `email profile` — no `openid`. F-A2-AQ-001
  // / F-A2-A8-001: requesting `openid` returns an `id_token` from the
  // token-exchange that we never validate (we read user info via the
  // `/userinfo` endpoint with the access token instead, which carries
  // the same `email_verified` claim). Keeping the unused token in
  // memory + log redaction surface area for no value violates the
  // minimum-privilege OAuth pattern (Stripe / GitHub legacy).
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: 'code',
    scope: 'email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Exchange the authorization code for tokens. The PKCE
 * `code_verifier` (RFC 7636) is threaded through from the state JWT
 * — Google computes its SHA-256 and compares against the
 * `code_challenge` we sent at initiate-time, rejecting the exchange
 * on mismatch. Effective even if the auth code is intercepted by an
 * attacker without the verifier.
 */
export async function exchangeGoogleCode(
  code: string,
  codeVerifier: string,
  config: Pick<CustomerAuthConfig, 'googleClientId' | 'googleClientSecret' | 'googleRedirectUri'>,
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: config.googleRedirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token exchange failed: ${response.status} ${text}`);
  }

  // We deliberately do not consume `id_token` even if Google sent
  // one (legacy clients, custom configs) — F-A2-A8-001 / AP. The
  // userinfo round-trip returns the same `email_verified` claim
  // we need, so an unused id_token would just be a future-developer
  // trap and a log-leak surface for no security value.
  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
  };
}

// ---------------------------------------------------------------------------
// User info
// ---------------------------------------------------------------------------

/**
 * Fetch the user's profile from Google using the access token.
 */
export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google userinfo fetch failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    id: string;
    email: string;
    verified_email: boolean;
    name: string;
    picture: string;
  };

  return {
    sub: data.id,
    email: data.email,
    emailVerified: data.verified_email,
    name: data.name ?? '',
    picture: data.picture ?? '',
  };
}

// ---------------------------------------------------------------------------
// Completion token (for new users who need to set a password)
// ---------------------------------------------------------------------------

/**
 * Sign a short-lived "completion" JWT for new Google users.
 * Contains the Google user info so the completion page can display it.
 * TTL: 10 minutes.
 */
export async function signCompletionToken(
  jwtSecret: string,
  googleUser: GoogleUserInfo,
): Promise<string> {
  const secret = new TextEncoder().encode(jwtSecret);

  return new SignJWT({
    purpose: 'google_completion',
    googleSub: googleUser.sub,
    email: googleUser.email,
    name: googleUser.name,
    picture: googleUser.picture,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(secret);
}

/**
 * Verify a completion token and extract the Google user info.
 */
export async function verifyCompletionToken(
  token: string,
  jwtSecret: string,
): Promise<GoogleUserInfo> {
  const secret = new TextEncoder().encode(jwtSecret);
  const { payload } = await safeJwtVerify(token, secret);

  if (payload['purpose'] !== 'google_completion') {
    throw new Error('Invalid completion token: wrong purpose');
  }

  return {
    sub: payload['googleSub'] as string,
    email: payload['email'] as string,
    emailVerified: true,
    name: (payload['name'] as string) ?? '',
    picture: (payload['picture'] as string) ?? '',
  };
}

/* -------------------------------------------------------------------------- */
/*  Confirm-link token (auto-link reauth gate — F-A2-C2-001)                  */
/* -------------------------------------------------------------------------- */

/**
 * Payload that the confirm-link token carries from the callback to
 * the `/confirm-link` page and back to the confirm-link endpoint.
 *
 * Why a server-signed token rather than a session cookie + DB row:
 * the callback is the only opportunity to capture the IdP's freshly
 * verified email + sub, and the token must survive the
 * cross-origin → same-origin transition on the frontend without
 * leaking who is being asked to confirm. Embedding the data in a
 * 10-minute HS256 JWT keeps it tamper-evident; the endpoint that
 * consumes it re-validates the customer row + sub against the DB
 * before committing the link.
 */
export interface ConfirmLinkTokenPayload {
  readonly customerId: string;
  readonly googleSub: string;
  readonly email: string;
  readonly name: string;
  readonly picture: string;
}

/**
 * Verified confirm-link token, with the JWT `jti` + `exp` exposed so
 * the consume-side endpoint can record the burn in `oauth_state_used`
 * (F-A2-A7-001).
 */
export interface VerifiedConfirmLinkToken extends ConfirmLinkTokenPayload {
  readonly jti: string;
  readonly expiresAt: Date;
}

/**
 * Sign a 10-minute confirm-link token. The customer ID is the row
 * the email lookup matched at callback time; the consume-side
 * endpoint will re-verify by `assertCustomerActive` so a row that
 * gets deleted between mint and consume is rejected with
 * `invalid_credentials`.
 */
export async function signConfirmLinkToken(
  jwtSecret: string,
  payload: ConfirmLinkTokenPayload,
): Promise<string> {
  const secret = new TextEncoder().encode(jwtSecret);
  return new SignJWT({
    purpose: 'google_confirm_link',
    customerId: payload.customerId,
    googleSub: payload.googleSub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(secret);
}

/**
 * Verify a confirm-link token and extract its payload. Throws on
 * expired / mis-purposed / unsigned tokens — the consume-endpoint
 * surfaces the failure as a generic `expired_token` 401 so an
 * attacker cannot tell tampered from genuinely-expired.
 *
 * Also exposes the JWT `jti` + `exp` so the consume-side endpoint
 * can burn the token in `oauth_state_used`, preventing replay even
 * if the URL leaks (F-A2-A7-001).
 */
export async function verifyConfirmLinkToken(
  token: string,
  jwtSecret: string,
): Promise<VerifiedConfirmLinkToken> {
  const secret = new TextEncoder().encode(jwtSecret);
  const { payload } = await safeJwtVerify(token, secret);
  if (payload['purpose'] !== 'google_confirm_link') {
    throw new Error('Invalid confirm-link token: wrong purpose');
  }
  const jti = payload['jti'];
  if (typeof jti !== 'string' || jti.length === 0) {
    throw new Error('Invalid confirm-link token: missing jti');
  }
  const exp = payload['exp'];
  if (typeof exp !== 'number') {
    throw new Error('Invalid confirm-link token: missing exp');
  }
  return {
    customerId: payload['customerId'] as string,
    googleSub: payload['googleSub'] as string,
    email: payload['email'] as string,
    name: (payload['name'] as string) ?? '',
    picture: (payload['picture'] as string) ?? '',
    jti,
    expiresAt: new Date(exp * 1000),
  };
}
