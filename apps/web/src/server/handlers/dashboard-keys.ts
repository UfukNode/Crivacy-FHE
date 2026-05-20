/**
 * Dashboard API key management handlers — list, create, delete, rotate.
 *
 * @module
 */

import type { ApiKeyMode, ApiKeyScope } from '@crivacy/shared-types';

import { hashApiKey } from '@/lib/auth/api-key';
import type { AuthConfig } from '@/lib/auth/config';
import { generateApiKey } from '@/lib/auth/keygen';
import type { CrivacyDatabase } from '@/lib/db/client';
import { acquireFirmResourceLock } from '@/lib/db/advisory-lock';
import { DEFAULT_TIER_LIMITS } from '@/lib/ratelimit/tiers';

import type { DashboardContext } from '../context';

/* ---------- Types ---------- */

export interface ApiKeyListItem {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly mode: ApiKeyMode;
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface CreateApiKeyInput {
  readonly name: string;
  readonly mode: ApiKeyMode;
  readonly scopes: readonly ApiKeyScope[];
  readonly expiresAt?: Date;
}

export interface CreateApiKeyResult {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly mode: ApiKeyMode;
  readonly scopes: readonly ApiKeyScope[];
  /** The raw key — shown only once. */
  readonly rawKey: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/* ---------- DI ---------- */

export interface ApiKeyDeps {
  readonly authConfig: Pick<AuthConfig, 'apiKeyBcryptCost'>;
  readonly listKeys: (ctx: DashboardContext) => Promise<readonly ApiKeyListItem[]>;
  readonly countActiveKeys: (db: CrivacyDatabase, firmId: string) => Promise<number>;
  readonly insertKey: (
    db: CrivacyDatabase,
    firmId: string,
    row: {
      readonly name: string;
      readonly prefix: string;
      readonly hash: string;
      readonly mode: ApiKeyMode;
      readonly scopes: readonly ApiKeyScope[];
      readonly expiresAt: Date | null;
    },
  ) => Promise<{ id: string; createdAt: Date }>;
  readonly revokeKey: (
    db: CrivacyDatabase,
    firmId: string,
    keyId: string,
    now: Date,
  ) => Promise<boolean>;
  readonly rotateKey: (
    db: CrivacyDatabase,
    firmId: string,
    keyId: string,
    newPrefix: string,
    newHash: string,
    now: Date,
  ) => Promise<boolean>;
}

/* ---------- Handlers ---------- */

/**
 * List all API keys for the firm.
 */
export async function handleListApiKeys(
  deps: ApiKeyDeps,
  ctx: DashboardContext,
): Promise<readonly ApiKeyListItem[]> {
  return deps.listKeys(ctx);
}

/**
 * Outcome union for the create handler — same shape the OAuth
 * client and webhook handlers emit so the POST route can translate
 * every branch to its own HTTP status without pattern-matching on
 * thrown errors.
 */
export type CreateApiKeyOutcome =
  | { readonly status: 'created'; readonly key: CreateApiKeyResult }
  | {
      readonly status: 'tier_exceeded';
      readonly tier: string;
      readonly maxSlots: number;
    };

/**
 * Create a new API key.
 */
export async function handleCreateApiKey(
  deps: ApiKeyDeps,
  ctx: DashboardContext,
  input: CreateApiKeyInput,
): Promise<CreateApiKeyOutcome> {
  // Tier slot check. Only non-revoked keys count — rotating a key
  // produces a new row + revokes the old one, and we don't want
  // rotation to transiently push a firm over the cap. Revoked
  // rows stay for audit history but don't consume a slot.
  const tier = ctx.firm.tier as keyof typeof DEFAULT_TIER_LIMITS;
  const tierLimits = DEFAULT_TIER_LIMITS[tier];
  const capSlots =
    tierLimits !== undefined && tierLimits.apiKeys !== null
      ? tierLimits.apiKeys
      : null;

  // Generate + hash OUTSIDE the transaction so the bcrypt cost
  // doesn't sit inside the advisory-lock window. Wasting a key on
  // a tier_exceeded bail is cheap — every key is a fresh opaque
  // secret that was never handed out, so the cost is exactly the
  // hash computation the firm would have paid on a successful
  // create anyway.
  const generated = generateApiKey(input.mode);
  const hashed = await hashApiKey(generated.full, deps.authConfig);

  // Serialise count + insert for this firm. Two concurrent
  // "Create key" requests for a paying tier (cap 5 on starter, 50
  // on pro) used to both read the same pre-insert count and both
  // insert, sneaking one slot over the ceiling. The per-firm
  // advisory lock makes the second caller block until the first
  // commits, read the fresh count, and bail with `tier_exceeded`.
  return ctx.db.transaction(async (tx) => {
    await acquireFirmResourceLock(tx, ctx.firm.id, 'api_keys');

    if (capSlots !== null) {
      const existingCount = await deps.countActiveKeys(tx, ctx.firm.id);
      if (existingCount >= capSlots) {
        return {
          status: 'tier_exceeded',
          tier: ctx.firm.tier,
          maxSlots: capSlots,
        };
      }
    }

    const { id, createdAt } = await deps.insertKey(tx, ctx.firm.id, {
      name: input.name,
      prefix: generated.prefix,
      hash: hashed.hash,
      mode: input.mode,
      scopes: input.scopes,
      expiresAt: input.expiresAt ?? null,
    });

    return {
      status: 'created',
      key: {
        id,
        name: input.name,
        prefix: generated.prefix,
        mode: input.mode,
        scopes: input.scopes,
        rawKey: generated.full,
        createdAt,
        expiresAt: input.expiresAt ?? null,
      },
    };
  });
}

/**
 * Revoke (soft-delete) an API key. Returns `true` when an actual row
 * was flipped, `false` when the (id, firmId) tuple matched nothing —
 * route layer translates `false` into a 404. BUG #43 (2026-04-25):
 * silently succeeding on cross-firm or non-existent UUIDs let a member
 * of one firm "DELETE 204" any other firm's key UUID and infer
 * existence (information leak).
 */
export async function handleDeleteApiKey(
  deps: ApiKeyDeps,
  ctx: DashboardContext,
  keyId: string,
): Promise<boolean> {
  const now = new Date();
  return deps.revokeKey(ctx.db, ctx.firm.id, keyId, now);
}

/**
 * Rotate an API key — generate a new key while revoking the old one.
 * Returns the new raw key on success, `null` when the (id, firmId)
 * tuple did not match. The hash is generated only when the row is
 * actually rotated, so a cross-firm or non-existent UUID does not
 * walk away with a freshly-minted plaintext that the caller might
 * (mistakenly or maliciously) treat as authoritative. BUG #43 fix.
 */
export async function handleRotateApiKey(
  deps: ApiKeyDeps,
  ctx: DashboardContext,
  keyId: string,
): Promise<{ rawKey: string; prefix: string } | null> {
  const now = new Date();
  const generated = generateApiKey('live');
  const hashed = await hashApiKey(generated.full, deps.authConfig);
  const rotated = await deps.rotateKey(ctx.db, ctx.firm.id, keyId, generated.prefix, hashed.hash, now);
  if (!rotated) return null;
  return { rawKey: generated.full, prefix: generated.prefix };
}
