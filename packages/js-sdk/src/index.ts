/**
 * @crivacy/js-sdk — public barrel.
 *
 * Import everything you need from this module path:
 *
 * ```ts
 * import { CrivacyClient, CrivacyOauthError } from '@crivacy/js-sdk';
 * ```
 */

export { CrivacyClient } from './client';
export { CrivacyOauthError, isCrivacyOauthError } from './errors';
export type { CrivacyOauthErrorCode, CrivacyOauthErrorOptions } from './errors';

export {
  computeCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from './pkce';
export type { CodeChallengeMethod } from './pkce';

export {
  clearAuthorizationRequest,
  createDefaultStorage,
  persistAuthorizationRequest,
  readAuthorizationRequest,
} from './storage';
export type { SdkStorage, StoredAuthorizationRequest } from './storage';

export type {
  AuthorizeOptions,
  AuthorizeUrl,
  CallbackResult,
  CrivacyClaims,
  CrivacyClientOptions,
  CrivacyScope,
  TokenResponse,
} from './types';

export { verifyDisclosure } from './chain';
export type { VerifyDisclosureOptions, FheCredentialView } from './chain';
