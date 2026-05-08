/**
 * OAuth 2.0 + OIDC library — barrel.
 *
 * Ordered so a first-time reader can trace a full flow:
 *
 *   errors    → OauthError taxonomy
 *   scopes    → parse / canonicalise / subset check / hash
 *   pkce      → S256 challenge/verifier primitives
 *   client    → client_id / client_secret / redirect_uri
 *   request   → authorize-request id generation
 *   codes     → authorization-code gen + hash
 *   tokens    → opaque access-token gen + hash
 *   claims    → scope → id_token claim mapping
 *   jwt       → sign id_token (HS256 via jose)
 */

export { OauthError, isOauthError } from './errors';
export type { OauthErrorCode } from './errors';

export {
  OAUTH_SCOPES,
  KNOWN_SCOPE_IDS,
  parseScope,
  expandImplicitScopes,
  canonicaliseScope,
  hashScope,
  isScopeSubset,
  assertScopeAllowed,
  assertConsentCovers,
  claimsForScopes,
} from './scopes';
export type { OauthScopeId } from './scopes';

export {
  KYC_LEVEL_ORDER,
  maxRequiredLevel,
  rankKycLevel,
} from './scopes-catalog';
export type { KycLevelName, ScopeRequiredLevel } from './scopes-catalog';

export {
  computeCodeChallenge,
  assertValidCodeChallenge,
  assertValidCodeVerifier,
  verifyCodeChallenge,
} from './pkce';
export type { CodeChallengeMethod } from './pkce';

export {
  CLIENT_ID_LIVE_PREFIX,
  CLIENT_ID_TEST_PREFIX,
  generateClientId,
  generateClientSecret,
  hashClientSecret,
  verifyClientSecret,
  validateRedirectUri,
  throwRedirectUriMismatch,
} from './client';
export type { ClientMode } from './client';

export {
  AUTHORIZATION_REQUEST_TTL_SECONDS,
  generateAuthorizationRequestId,
} from './request';

export {
  AUTHORIZATION_CODE_TTL_SECONDS,
  generateAuthorizationCode,
  hashAuthorizationCode,
} from './codes';

export {
  ACCESS_TOKEN_TTL_SECONDS,
  generateAccessToken,
  hashAccessToken,
} from './tokens';

export { toOauthClaims } from '@/lib/credentials/view';
export type {
  OauthClaimSet,
  OauthClaimInput,
  CredentialView,
} from '@/lib/credentials/view';

export { signIdToken } from './jwt';
export type { IdTokenInput, SignedIdToken } from './jwt';

export { dispatchOauthConsentEvent } from './webhook-events';
export type { OauthConsentEventInput, OauthConsentEventType } from './webhook-events';
