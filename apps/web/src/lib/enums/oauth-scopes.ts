/**
 * UI metadata for OAuth / OIDC scopes.
 *
 * Unlike the webhook and api-key enums, the OAuth scope catalog
 * already carries its own descriptions + claim map inside
 * `lib/oauth/scopes.ts`. This module is a thin re-export that also
 * supplies short UI labels the scope checkboxes render next to
 * each option. Importing through here (not directly via
 * `OAUTH_SCOPES`) keeps the "all UI enum surfaces go through
 * /lib/enums" convention consistent across the codebase.
 *
 * @module
 */

// Import from the crypto-free catalog module, not `@/lib/oauth/scopes`
// (which pulls in `node:crypto` via `hashScope`). This keeps the
// dashboard client bundle free of Node built-ins while still sharing
// the single source-of-truth scope definitions.
import {
  KNOWN_SCOPE_IDS,
  OAUTH_SCOPES,
  type OauthScopeId,
  type ScopeRequiredLevel,
} from '@/lib/oauth/scopes-catalog';

export type { OauthScopeId, ScopeRequiredLevel } from '@/lib/oauth/scopes-catalog';

export const OAUTH_SCOPE_VALUES: readonly OauthScopeId[] = KNOWN_SCOPE_IDS;

/**
 * Short hint rendered next to a scope checkbox so firms see the
 * implicit KYC level demand (e.g. `kyc:address` requires a
 * Standard-level user). Returns an empty string for scopes that
 * impose no level (`openid`).
 */
export function levelHint(required: ScopeRequiredLevel): string {
  switch (required) {
    case 'basic':
      return 'Requires Basic level user (identity + liveness)';
    case 'enhanced':
      return 'Requires Enhanced level user (includes proof of address)';
    case null:
      return '';
  }
}

/**
 * Labels + descriptions pulled from the canonical `OAUTH_SCOPES`
 * catalog. Using `satisfies` keeps the metadata exhaustive over
 * the live scope id union — a new scope added to `OAUTH_SCOPES`
 * without a label here becomes a TS error.
 */
export const OAUTH_SCOPE_METADATA = {
  openid: {
    label: 'openid',
    description: OAUTH_SCOPES.openid.description,
    requiredLevel: OAUTH_SCOPES.openid.requiredLevel,
  },
  kyc: {
    label: 'kyc',
    description: OAUTH_SCOPES.kyc.description,
    requiredLevel: OAUTH_SCOPES.kyc.requiredLevel,
  },
  'kyc:address': {
    label: 'kyc:address',
    description: OAUTH_SCOPES['kyc:address'].description,
    requiredLevel: OAUTH_SCOPES['kyc:address'].requiredLevel,
  },
  'kyc:scores': {
    label: 'kyc:scores',
    description: OAUTH_SCOPES['kyc:scores'].description,
    requiredLevel: OAUTH_SCOPES['kyc:scores'].requiredLevel,
  },
  'credential': {
    label: 'credential',
    description: OAUTH_SCOPES['credential'].description,
    requiredLevel: OAUTH_SCOPES['credential'].requiredLevel,
  },
} as const satisfies Record<
  OauthScopeId,
  {
    readonly label: string;
    readonly description: string;
    readonly requiredLevel: ScopeRequiredLevel;
  }
>;
