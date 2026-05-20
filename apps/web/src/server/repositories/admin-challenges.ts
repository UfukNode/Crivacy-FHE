/**
 * Admin login challenge repository — CRUD for the two-step admin login flow.
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';

import { and, eq, lt, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { adminLoginChallenges } from '@/lib/db/schema';

/* ---------- Constants ---------- */

/** Challenge token TTL: 2 minutes. */
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

/** Maximum TOTP attempts per challenge before it becomes invalid. */
export const MAX_TOTP_ATTEMPTS_PER_CHALLENGE = 3;

/* ---------- Helpers ---------- */

/**
 * Generate a cryptographically random challenge token (32 bytes, hex-encoded).
 * Returns both the raw token (sent to client) and its SHA-256 hash (stored in DB).
 */
export function generateChallengeToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * Hash a raw challenge token for DB lookup.
 */
export function hashChallengeToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/* ---------- Challenge row type ---------- */

export interface AdminLoginChallengeRow {
  readonly id: string;
  readonly adminUserId: string;
  readonly challengeTokenHash: string;
  readonly ipAddress: string;
  readonly totpAttempts: number;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly createdAt: Date;
}

/* ---------- CRUD ---------- */

/**
 * Create a new login challenge after successful email+password verification.
 */
export async function createAdminLoginChallenge(
  db: CrivacyDatabase,
  input: {
    readonly adminUserId: string;
    readonly challengeTokenHash: string;
    readonly ipAddress: string;
    readonly now: Date;
  },
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(input.now.getTime() + CHALLENGE_TTL_MS);

  const result = await db
    .insert(adminLoginChallenges)
    .values({
      adminUserId: input.adminUserId,
      challengeTokenHash: input.challengeTokenHash,
      ipAddress: input.ipAddress,
      expiresAt,
    })
    .returning({ id: adminLoginChallenges.id, expiresAt: adminLoginChallenges.expiresAt });

  const row = result[0];
  if (row === undefined) throw new Error('Failed to insert admin login challenge');
  return row;
}

/**
 * Find a valid (not expired, not used, within attempt limit) challenge by token hash.
 *
 * Returns null if:
 *   - No matching row
 *   - Challenge expired
 *   - Challenge already used
 *   - TOTP attempts exhausted
 */
export async function findValidAdminLoginChallenge(
  db: CrivacyDatabase,
  tokenHash: string,
  now: Date,
): Promise<AdminLoginChallengeRow | null> {
  const rows = await db
    .select()
    .from(adminLoginChallenges)
    .where(
      and(
        eq(adminLoginChallenges.challengeTokenHash, tokenHash),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  // Expired
  if (row.expiresAt < now) return null;

  // Already used
  if (row.usedAt !== null) return null;

  // Attempts exhausted
  if (row.totpAttempts >= MAX_TOTP_ATTEMPTS_PER_CHALLENGE) return null;

  return row;
}

/**
 * Increment the TOTP attempt count for a challenge (after a failed TOTP code).
 */
export async function incrementChallengeTotpAttempts(
  db: CrivacyDatabase,
  challengeId: string,
): Promise<void> {
  await db
    .update(adminLoginChallenges)
    .set({ totpAttempts: sql`${adminLoginChallenges.totpAttempts} + 1` })
    .where(eq(adminLoginChallenges.id, challengeId));
}

/**
 * Mark a challenge as used after successful TOTP verification.
 */
export async function markChallengeUsed(
  db: CrivacyDatabase,
  challengeId: string,
  now: Date,
): Promise<void> {
  await db
    .update(adminLoginChallenges)
    .set({ usedAt: now })
    .where(eq(adminLoginChallenges.id, challengeId));
}

/**
 * Delete expired challenges (housekeeping, called on each step-1 request).
 */
export async function cleanupExpiredChallenges(
  db: CrivacyDatabase,
  now: Date,
): Promise<void> {
  await db
    .delete(adminLoginChallenges)
    .where(lt(adminLoginChallenges.expiresAt, now));
}
