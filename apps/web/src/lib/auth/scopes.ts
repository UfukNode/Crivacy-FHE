/**
 * API key scopes.
 *
 * Scopes are the only authorization primitive for the firm-facing API;
 * tier (`free` / `starter` / `pro` / `enterprise`) is separate and
 * affects rate limits and feature gating, not what a given key can
 * actually do. A key holds any subset of the five scopes declared in
 * `@crivacy/shared-types::ApiKeyScope`.
 *
 * This module provides the pure helpers — parsing, set intersection,
 * subset checks — that route middleware needs. It does NOT touch the
 * database. Repositories call `parseScopes()` to sanitize a raw
 * `text[]` column into a strongly-typed array before returning it.
 */

import type { ApiKeyScope } from '@crivacy/shared-types';

import { AuthError } from './errors';

/**
 * Frozen list of every valid scope string. Keep this in sync with the
 * Zod enum in `apps/web/src/lib/openapi/schemas/enums.ts::ApiKeyScope`
 * and the TypeScript union in
 * `packages/shared-types/src/index.ts::ApiKeyScope` — the round-trip
 * test in `tests/auth/scopes.test.ts` asserts the three match.
 */
export const ALL_SCOPES = [
  'kyc:create',
  'kyc:read',
  'kyc:verify',
  'webhooks:manage',
  'usage:read',
] as const satisfies readonly ApiKeyScope[];

export type AllScopes = (typeof ALL_SCOPES)[number];

/** Runtime membership check. */
export function isValidScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (ALL_SCOPES as readonly string[]).includes(value);
}

/**
 * Convert a raw `string[]` (e.g. from `api_keys.scopes text[]`) into a
 * validated, deduplicated `ApiKeyScope[]`. Unknown strings throw an
 * `AuthError('unknown_scope')` — this is the right call because the
 * data came from our own DB, so a surprise there means a bug upstream.
 */
export function parseScopes(raw: readonly unknown[]): ApiKeyScope[] {
  const seen = new Set<ApiKeyScope>();
  for (const value of raw) {
    if (!isValidScope(value)) {
      throw new AuthError('unknown_scope', `unknown scope value: ${JSON.stringify(value)}`);
    }
    seen.add(value);
  }
  // Preserve the canonical order defined in `ALL_SCOPES` so equality
  // comparisons on the output array are deterministic.
  return ALL_SCOPES.filter((s) => seen.has(s));
}

/**
 * Return true iff `actual` contains every scope in `required`. An
 * empty `required` list trivially matches (route-level convention:
 * "no scope needed"). Duplicates in either list are tolerated.
 */
export function hasRequiredScopes(
  actual: readonly ApiKeyScope[],
  required: readonly ApiKeyScope[],
): boolean {
  if (required.length === 0) {
    return true;
  }
  const actualSet = new Set(actual);
  for (const scope of required) {
    if (!actualSet.has(scope)) {
      return false;
    }
  }
  return true;
}

/**
 * Return the intersection of two scope lists in canonical order.
 * Used by the rotation flow: a freshly issued key may carry at most
 * the scopes of the key it replaces.
 */
export function intersectScopes(
  a: readonly ApiKeyScope[],
  b: readonly ApiKeyScope[],
): ApiKeyScope[] {
  const bSet = new Set(b);
  return ALL_SCOPES.filter((s) => a.includes(s) && bSet.has(s));
}

/**
 * Return scopes in `a` that are not in `b`. Used by the dashboard to
 * explain why a rotation narrowed privileges.
 */
export function subtractScopes(
  a: readonly ApiKeyScope[],
  b: readonly ApiKeyScope[],
): ApiKeyScope[] {
  const bSet = new Set(b);
  return ALL_SCOPES.filter((s) => a.includes(s) && !bSet.has(s));
}
