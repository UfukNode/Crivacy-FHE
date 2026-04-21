/**
 * Public types for the Crivacy JS SDK.
 *
 * The scope catalog + claim names mirror the `@crivacy/shared-types`
 * definitions used by the app and are re-declared here so firms
 * installing just this package don't need an extra dependency.
 *
 * @module
 */

export type CrivacyScope =
  | 'openid'
  | 'kyc'
  | 'kyc:address'
  | 'kyc:scores'
  | 'credential';

/**
 * The Crivacy userinfo / id_token claim shape. Every field is
 * optional — a firm only sees the claims its scope list covered.
 * `sub` is present whenever `openid` was requested. The `crivacy_*`
 * family (proof_hash / level / valid_until / network / contract_id /
 * disclosure_blob) is gated by the `credential` scope; request that
 * scope to receive the on-chain proof bundle and feed it into
 * `verifyDisclosure()` for trustless verification against your own
 * chain participant.
 */
export interface CrivacyClaims {
  readonly sub?: string;
  readonly identity_verified?: boolean;
  readonly liveness_verified?: boolean;
  readonly address_verified?: boolean;
  readonly humanity_score?: number;
  readonly credential_proof_hash?: string;
  readonly credential_level?: 'basic' | 'enhanced';
  readonly credential_valid_until?: string;
  readonly credential_network?: string;
  readonly credential_contract_id?: string | null;
  /**
   * Legacy disclosure blob field. Retained for wire-compatibility but
   * no longer produced under the FHE model — verification reads the
   * `CrivacyKYC` contract directly (see {@link fhe_kyc_user_address} /
   * {@link fhe_kyc_contract}), so this is always absent in practice.
   */
  readonly credential_credential_blob?: string;
  /**
   * The subject's EVM address — the on-chain key of their `CrivacyKYC`
   * credential on Zama FHEVM (Sepolia). Present when the `credential` scope is
   * granted and a credential is active. Pass to {@link verifyDisclosure} with a
   * viem client to read the credential's plaintext lifecycle straight from the
   * chain, without trusting Crivacy's claim set.
   */
  readonly fhe_kyc_user_address?: string;
  /** The `CrivacyKYC` registry contract address on Sepolia. */
  readonly fhe_kyc_contract?: string;
}

export interface CrivacyClientOptions {
  /**
   * Full origin of the Crivacy deployment — no trailing slash.
   * Defaults to production: `https://app.crivacy.io`.
   */
  readonly issuer?: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /**
   * Confidential clients only. MUST NOT be set in the browser —
   * pass only from server code when calling {@link CrivacyClient.exchangeCode}.
   */
  readonly clientSecret?: string;
  /**
   * Fetch implementation. Defaults to the global `fetch`. Override
   * for tests, Node <18, or edge runtimes that expose a custom
   * implementation.
   */
  readonly fetch?: typeof fetch;
}

export interface AuthorizeOptions {
  readonly scope: readonly CrivacyScope[];
  /**
   * Optional OIDC nonce. When omitted, the SDK generates one and
   * stashes it in storage so the callback can verify the id_token.
   */
  readonly nonce?: string;
  /**
   * Override the redirect_uri for this particular authorize call.
   * Defaults to the client-level value. Useful when a single client
   * serves multiple pages with distinct callbacks.
   */
  readonly redirectUri?: string;
  /**
   * BCP 47 tag ordering the consent page should follow (e.g. `"tr en"`).
   * Ignored silently if Crivacy doesn't support any of them.
   */
  readonly uiLocales?: string;
}

export interface AuthorizeUrl {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce?: string;
}

export interface CallbackResult {
  /** Raw authorization code returned by Crivacy. */
  readonly code: string;
  /**
   * The `state` value the server echoed. Already validated against
   * storage — present as a convenience only.
   */
  readonly state: string;
  /**
   * PKCE `code_verifier` the code was bound to. Pass this to
   * {@link CrivacyClient.exchangeCode} along with the code.
   */
  readonly codeVerifier: string;
  /** The exact redirect_uri the authorize step used. */
  readonly redirectUri: string;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly scope: string;
  readonly id_token?: string;
  readonly refresh_token?: string;
}
