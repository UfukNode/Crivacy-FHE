/**
 * Auth lookup repository — resolves an API key header into
 * `(ResolvedApiKey, ResolvedFirm)`.
 *
 * This is the single function the `apiRoute` middleware injects via DI.
 * It is intentionally thin: extract prefix → DB lookup → bcrypt verify →
 * firm lookup → return. All error paths surface through `AuthError` so
 * the error-mapper can translate them into the correct HTTP status.
 *
 * @module
 */

import { and, eq, isNull } from 'drizzle-orm';

import { AuthError, extractPrefix, safeParseApiKey, verifyApiKey } from '@/lib/auth';
import type { CrivacyDatabase } from '@/lib/db/client';
import { apiKeys, firms } from '@/lib/db/schema';

import type { ResolvedApiKey, ResolvedFirm } from '../context';
import type { AuthLookupFn } from '../middleware/api-route';

/**
 * Build an `AuthLookupFn` for production use. The function closes over no
 * mutable state; it is safe to call concurrently from multiple requests.
 *
 * The optional `clock` parameter enables tests to freeze the "now" used
 * for expiry checks; production callers omit it and get `new Date()`.
 */
export function buildAuthLookup(clock: () => Date = () => new Date()): AuthLookupFn {
  return async (
    db: CrivacyDatabase,
    rawHeader: string,
  ): Promise<{ apiKey: ResolvedApiKey; firm: ResolvedFirm }> => {
    // --- 1. Parse the key format ---
    const parsed = safeParseApiKey(rawHeader);
    if (parsed === null) {
      throw new AuthError('invalid_api_key', 'API key format is invalid.');
    }

    const prefix = extractPrefix(rawHeader);
    if (prefix === null) {
      throw new AuthError('invalid_api_key', 'API key prefix could not be extracted.');
    }

    // --- 2. Look up the key row by prefix ---
    const rows = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw new AuthError('invalid_api_key', 'API key not found or has been revoked.');
    }

    // --- 3. Check expiry ---
    const now = clock();
    if (row.expiresAt !== null && row.expiresAt <= now) {
      throw new AuthError('expired_api_key', 'API key has expired.');
    }

    // --- 4. Verify bcrypt hash ---
    const hashValid = await verifyApiKey(rawHeader, row.hash);
    if (!hashValid) {
      throw new AuthError('api_key_mismatch', 'API key does not match.');
    }

    // --- 5. Update last-used metadata (fire-and-forget, non-blocking) ---
    void db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(eq(apiKeys.id, row.id))
      .then(() => {})
      .catch(() => {});

    // --- 6. Look up the firm ---
    const firmRows = await db.select().from(firms).where(eq(firms.id, row.firmId)).limit(1);

    const firmRow = firmRows[0];
    if (firmRow === undefined) {
      throw new AuthError('invalid_api_key', 'Firm associated with this API key no longer exists.');
    }

    // --- 7. Parse scopes from text[] ---
    const scopes = filterKnownScopes(row.scopes);

    // --- 8. Build resolved entities ---
    const resolvedApiKey: ResolvedApiKey = {
      id: row.id,
      firmId: row.firmId,
      prefix: row.prefix,
      name: row.name,
      scopes,
      mode: row.mode as ResolvedApiKey['mode'],
    };

    const resolvedFirm: ResolvedFirm = {
      id: firmRow.id,
      slug: firmRow.slug,
      displayName: firmRow.name,
      tier: firmRow.tier as ResolvedFirm['tier'],
      deletedAt: firmRow.deletedAt,
    };

    return { apiKey: resolvedApiKey, firm: resolvedFirm };
  };
}

/**
 * Filter the `scopes text[]` column to only known scopes. Unknown scopes
 * are silently dropped — they may come from a future schema version that
 * added scopes before the API code was deployed.
 */
function filterKnownScopes(raw: string[]): ResolvedApiKey['scopes'] {
  const KNOWN_SCOPES: ReadonlySet<string> = new Set([
    'kyc:create',
    'kyc:read',
    'kyc:verify',
    'webhooks:manage',
    'usage:read',
  ]);
  return raw.filter((s) => KNOWN_SCOPES.has(s)) as unknown as ResolvedApiKey['scopes'];
}

/** Default production instance. */
export const authLookup = buildAuthLookup();
