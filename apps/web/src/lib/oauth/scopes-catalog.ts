/**
 * OAuth scope catalog — the source-of-truth static table.
 *
 * Split out from `scopes.ts` so both server handlers (which also want
 * `parseScope` / `hashScope` and therefore drag `node:crypto`) and
 * client UI surfaces (`lib/enums/oauth-scopes`, dashboard pages) can
 * share the same scope definitions without the client bundle pulling
 * in Node built-ins.
 *
 * This file is *only* static data + types — no functions, no runtime
 * side effects, no crypto. Safe to import from any execution context.
 *
 * Adding a new scope means:
 *
 *   1. Add a new entry to {@link OAUTH_SCOPES}.
 *   2. Decide which claim(s) it unlocks in `lib/oauth/claims.ts`.
 *   3. Add the human-readable description / label to
 *      `lib/enums/oauth-scopes.ts` (metadata map satisfies the
 *      `OauthScopeId` union, so missing scopes become a TS error).
 *
 * @module
 */

/**
 * The credential KYC level a scope implicitly requires. A scope with
 * `requiredLevel = null` can be satisfied regardless of credential
 * state (the only one today is `openid`, which just surfaces the
 * Crivacy user id). Everything else needs at least a basic-level
 * credential; `kyc:address` escalates to `enhanced` because address
 * verification is folded into the Enhanced tier.
 *
 * This field powers the KYC gate on the consent screen — the bootstrap
 * endpoint compares the user's current credential level against the
 * maximum `requiredLevel` among the requested scopes and returns a
 * `needsKyc` / `needsKycUpgrade` signal so the UI can redirect to the
 * Didit flow before letting the user approve. Keeping the mapping
 * here (next to the claims) means the gate is drift-safe: a new
 * scope added without updating this field is a TypeScript error via
 * the `satisfies` constraint below.
 */
export type ScopeRequiredLevel = 'basic' | 'enhanced' | null;

/**
 * The full list of scopes the authorize endpoint accepts. Keep
 * Crivacy-specific scopes under the `kyc:` prefix so the catalog
 * doesn't collide with future standard OIDC scopes (`profile`,
 * `email`, etc. are reserved even if unused today).
 */
export const OAUTH_SCOPES = {
  openid: {
    id: 'openid',
    description:
      'Required for OpenID Connect. Issues an id_token with your Crivacy user id.',
    claims: ['sub'],
    requiredLevel: null,
  },
  kyc: {
    id: 'kyc',
    description: 'Whether you have completed identity verification (ID + liveness + face match).',
    claims: ['identity_verified', 'liveness_verified'],
    requiredLevel: 'basic',
  },
  'kyc:address': {
    id: 'kyc:address',
    description: 'Whether you have completed the proof-of-address step.',
    claims: ['address_verified'],
    requiredLevel: 'enhanced',
  },
  'kyc:scores': {
    id: 'kyc:scores',
    description: 'Numerical quality / humanity scores from your verification.',
    claims: ['humanity_score'],
    requiredLevel: 'basic',
  },
  'credential': {
    id: 'credential',
    description:
      'Your on-chain credential reference (proof hash, validity, issuing validator). Required for on-chain verification.',
    claims: [
      'credential_proof_hash',
      'credential_level',
      'credential_valid_until',
      'credential_network',
      'credential_contract_id',
    ],
    requiredLevel: 'basic',
  },
} as const satisfies Record<
  string,
  {
    readonly id: string;
    readonly description: string;
    readonly claims: readonly string[];
    readonly requiredLevel: ScopeRequiredLevel;
  }
>;

export type OauthScopeId = keyof typeof OAUTH_SCOPES;

/** Every scope id the product recognises. Iteration order is stable. */
export const KNOWN_SCOPE_IDS: readonly OauthScopeId[] = Object.keys(OAUTH_SCOPES) as OauthScopeId[];

/**
 * Ordered KYC level hierarchy. `basic < enhanced`. Used by the
 * consent bootstrap to decide whether a user's current credential
 * level is high enough to satisfy the requested scopes. `enhanced`
 * is the single "address-included" tier (basic = identity + liveness,
 * enhanced = + proof-of-address).
 */
export const KYC_LEVEL_ORDER = ['basic', 'enhanced'] as const;
export type KycLevelName = (typeof KYC_LEVEL_ORDER)[number];

/**
 * Rank a level; returns `-1` for the null / missing state so it
 * compares below every real level. Callers typically want
 * `rankKycLevel(user) >= rankKycLevel(required)`.
 */
export function rankKycLevel(level: ScopeRequiredLevel | string | null | undefined): number {
  if (level === null || level === undefined) return -1;
  const idx = (KYC_LEVEL_ORDER as readonly string[]).indexOf(level);
  return idx;
}

/**
 * Given a set of requested scope ids, return the highest
 * `requiredLevel` any of them demand. Used by the bootstrap to
 * collapse "all scope requirements" into one "at-least this level"
 * signal.
 */
export function maxRequiredLevel(scopes: readonly OauthScopeId[]): ScopeRequiredLevel {
  let highest: ScopeRequiredLevel = null;
  let highestRank = -1;
  for (const id of scopes) {
    const req = OAUTH_SCOPES[id].requiredLevel;
    const rank = rankKycLevel(req);
    if (rank > highestRank) {
      highestRank = rank;
      highest = req;
    }
  }
  return highest;
}
