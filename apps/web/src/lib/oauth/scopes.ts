/**
 * OAuth scope primitives.
 *
 * Scopes are space-separated tokens in the OAuth 2.0 wire format.
 * This module normalises them (trim → split → dedupe → sort) so a
 * request asking for `"kyc address openid"` and one asking for
 * `"openid kyc address"` hash to the same cache key — firm libraries
 * often emit scopes in arbitrary order.
 *
 * The full scope catalog is declared here so every consumer (authorize
 * endpoint, consent UI, claims builder, OpenAPI spec) reads from one
 * place. Adding a new scope means:
 *
 *   1. Add a new entry to {@link OAUTH_SCOPES}.
 *   2. Decide which claim(s) it unlocks in `lib/oauth/claims.ts`.
 *   3. Add the human-readable description to the consent screen copy
 *      (keyed by {@link OAUTH_SCOPES[id].description}).
 *
 * Scope handling is the single most common attack surface in OAuth
 * deployments — an authorize endpoint that accepts arbitrary scope
 * strings leaks capabilities. Every entry point MUST route through
 * `parseScope` + `assertScopeSubset`.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { OauthError } from './errors';
import { KNOWN_SCOPE_IDS, OAUTH_SCOPES, type OauthScopeId } from './scopes-catalog';

// The static scope catalog is declared in `scopes-catalog.ts` so client
// bundles can read it without dragging `node:crypto` (used by
// `hashScope` below) into the webpack graph. Server-side callers keep
// importing catalog symbols from this module for backward-compat.
export { KNOWN_SCOPE_IDS, OAUTH_SCOPES, type OauthScopeId };

// ---------------------------------------------------------------------------
// Parse + canonicalise
// ---------------------------------------------------------------------------

/**
 * Split + trim + dedupe + validate a raw scope string. Unknown scopes
 * become `invalid_scope` — unlike some OAuth providers, we refuse to
 * silently drop unknown entries because a silent drop is the most
 * common "misconfigured firm can't verify anyone" support ticket.
 *
 * After validation the scope list is passed through
 * {@link expandImplicitScopes} so callers downstream always see the
 * same fully-resolved set. Implicit expansion is intentional, not a
 * courtesy: Crivacy's value prop over Web2 KYC is on-chain
 * verifiability, which requires `credential` claims to reach the
 * firm. Granting a `kyc:*` scope without chain references would
 * leave the firm back in "trust Crivacy's word" land.
 */
export function parseScope(raw: string | null | undefined): readonly OauthScopeId[] {
  if (raw === null || raw === undefined) {
    throw new OauthError('invalid_scope', 'Scope parameter is required.');
  }
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new OauthError('invalid_scope', 'Scope parameter is empty.');
  }
  const seen = new Set<string>();
  const out: OauthScopeId[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (!(token in OAUTH_SCOPES)) {
      throw new OauthError('invalid_scope', `Unknown scope: ${token}`);
    }
    out.push(token as OauthScopeId);
  }
  return expandImplicitScopes(out);
}

/**
 * Auto-grant dependent scopes so firms can't accidentally opt out
 * of the core product guarantees. Today the only rule is:
 *
 *   any `kyc` or `kyc:*` → also grant `credential`
 *
 * Every Crivacy credential lives on-chain; a firm that holds a KYC
 * claim without the chain reference has no way to audit that
 * claim independently, which defeats the whole point of the
 * product. Rather than making `credential` an optional opt-in
 * (where a confused integration silently degrades to Web2-trust
 * mode), we treat it as a companion scope and attach it whenever
 * any `kyc*` scope is requested or granted.
 *
 * Returns a fresh array; the caller's input is not mutated.
 */
export function expandImplicitScopes(
  scopes: readonly OauthScopeId[],
): readonly OauthScopeId[] {
  const hasAnyKycScope = scopes.some((s) => s === 'kyc' || s.startsWith('kyc:'));
  if (!hasAnyKycScope) return scopes;
  if (scopes.includes('credential')) return scopes;
  return [...scopes, 'credential'];
}

/**
 * Canonicalise a parsed scope list. Sorting alphabetically means
 * `"kyc openid"` and `"openid kyc"` hash identically — downstream
 * cache keys + audit lookups stay correct even if two firm apps
 * stringify their scope set in different orders.
 */
export function canonicaliseScope(scopes: readonly OauthScopeId[]): string {
  const deduped = Array.from(new Set(scopes)).sort();
  return deduped.join(' ');
}

/** SHA-256 hex of the canonical scope string — used as cache key. */
export function hashScope(scopes: readonly OauthScopeId[]): string {
  return createHash('sha256').update(canonicaliseScope(scopes)).digest('hex');
}

// ---------------------------------------------------------------------------
// Subset + escalation guards
// ---------------------------------------------------------------------------

/**
 * Return true when every scope in `requested` is also in `allowed`.
 * Used to check the client's `allowed_scopes` cap and cached
 * consent's scope coverage.
 */
export function isScopeSubset(
  requested: readonly OauthScopeId[],
  allowed: readonly OauthScopeId[],
): boolean {
  const allowedSet = new Set(allowed);
  for (const scope of requested) {
    if (!allowedSet.has(scope)) return false;
  }
  return true;
}

/**
 * Throw `invalid_scope` (OAuth standard code) when the request exceeds
 * what the client is allowed to ask for. Called in the authorize
 * handler after the client lookup succeeds.
 */
export function assertScopeAllowed(
  requested: readonly OauthScopeId[],
  clientAllowed: readonly OauthScopeId[],
): void {
  if (!isScopeSubset(requested, clientAllowed)) {
    const extras = requested.filter((s) => !clientAllowed.includes(s));
    throw new OauthError(
      'invalid_scope',
      `Client is not permitted to request scopes: ${extras.join(' ')}`,
    );
  }
}

/**
 * Throw `consent_scope_escalation` when a cached consent does not
 * cover the current request. Distinct from `assertScopeAllowed` —
 * this one fires AFTER client limits are verified; it specifically
 * detects that user consented to a smaller set previously and the
 * firm now wants more.
 */
export function assertConsentCovers(
  requested: readonly OauthScopeId[],
  consented: readonly OauthScopeId[],
): void {
  if (!isScopeSubset(requested, consented)) {
    const extras = requested.filter((s) => !consented.includes(s));
    throw new OauthError(
      'consent_scope_escalation',
      `Your previous consent did not include: ${extras.join(' ')}. Re-consent required.`,
    );
  }
}

/**
 * Map a scope list to the set of id_token claims they unlock. The
 * claims builder walks this map plus the user's KYC state to decide
 * what lands in the final token.
 */
export function claimsForScopes(scopes: readonly OauthScopeId[]): readonly string[] {
  const out = new Set<string>();
  for (const scope of scopes) {
    for (const claim of OAUTH_SCOPES[scope].claims) {
      out.add(claim);
    }
  }
  return Array.from(out);
}
