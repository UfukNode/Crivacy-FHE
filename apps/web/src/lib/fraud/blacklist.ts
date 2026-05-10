/**
 * Blacklist data operations — CRUD for `customer_blacklist`.
 *
 * Every function accepts the Drizzle database handle as the first
 * argument, following the DI pattern used throughout the codebase.
 * The blacklist is keyed by SHA-256 hashes of PII (email, document
 * ID) so the table never stores raw personal data.
 *
 * Hash computation:
 *   * Email: `sha256(email.toLowerCase().trim())`
 *   * Document: `sha256(documentId.trim())` — casing preserved
 *     because document numbers are case-sensitive in some countries
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { desc, eq, or, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { customerBlacklist } from '@/lib/db/schema';
import type { CustomerBlacklistEntry, NewCustomerBlacklistEntry } from '@/lib/db/schema';

import type { FraudReason } from './types';

/* ---------- Hashing ---------- */

/**
 * Compute the SHA-256 hex digest of an email address. The email is
 * lowercased and trimmed before hashing to ensure consistent lookups
 * regardless of how the email was entered.
 */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

/**
 * Compute the SHA-256 hex digest of a document identifier. Trimmed
 * but NOT lowercased because document numbers may be case-sensitive
 * in some jurisdictions.
 */
export function hashDocument(documentId: string): string {
  return createHash('sha256').update(documentId.trim()).digest('hex');
}

/* ---------- Types ---------- */

export interface AddToBlacklistInput {
  readonly emailHash: string | null;
  readonly documentHash?: string | undefined;
  readonly walletAddressHash?: string | undefined;
  /**
   * SHA-256 of the matched Didit session id (Sprint 6). Populated when
   * the cascade-ban path tripped on a face_search 1:N hit. The same
   * hash is checked at the pre-Didit start-session gate to short-
   * circuit repeat attempts without going to Didit.
   */
  readonly faceHash?: string | undefined;
  readonly reason: FraudReason;
  /** Origin: `'didit_webhook'` for auto-ban, `'admin_manual'` for human ban. */
  readonly source: string;
  readonly diditSessionId?: string | undefined;
  readonly customerId?: string | undefined;
  readonly bannedBy?: string | undefined;
  readonly notes?: string | undefined;
}

/* ---------- Operations ---------- */

/**
 * Insert a new blacklist entry. Returns the persisted row including
 * the auto-generated `id` and `createdAt`.
 */
export async function addToBlacklist(
  db: CrivacyDatabase,
  input: AddToBlacklistInput,
): Promise<CustomerBlacklistEntry> {
  const values: NewCustomerBlacklistEntry = {
    emailHash: input.emailHash ?? null,
    documentHash: input.documentHash ?? null,
    walletAddressHash: input.walletAddressHash ?? null,
    faceHash: input.faceHash ?? null,
    reason: input.reason,
    source: input.source,
    diditSessionId: input.diditSessionId ?? null,
    customerId: input.customerId ?? null,
    bannedBy: input.bannedBy ?? null,
    notes: input.notes ?? null,
  };

  const rows = await db.insert(customerBlacklist).values(values).returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error('Blacklist insert returned no rows.');
  }
  return row;
}

/**
 * Check if an email hash, document hash, or wallet address hash is
 * blacklisted. Returns `true` if any matching row exists. The check
 * is an OR — any single match is sufficient for a positive hit.
 *
 * At least one hash must be provided; all-null returns false.
 */
export async function isBlacklisted(
  db: CrivacyDatabase,
  emailHash: string | null,
  documentHash?: string,
  walletAddressHash?: string,
): Promise<boolean> {
  const parts = [];
  if (emailHash !== null) parts.push(eq(customerBlacklist.emailHash, emailHash));
  if (documentHash !== undefined) parts.push(eq(customerBlacklist.documentHash, documentHash));
  if (walletAddressHash !== undefined) parts.push(eq(customerBlacklist.walletAddressHash, walletAddressHash));
  if (parts.length === 0) return false;

  const conditions = parts.length === 1 ? parts[0]! : or(...parts);

  const result = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(customerBlacklist)
    .where(conditions);

  const countStr = result[0]?.count ?? '0';
  return parseInt(countStr, 10) > 0;
}

/**
 * Hash a wallet address for blacklist lookups.
 * Same SHA-256 strategy as email, but without lowercasing
 * (wallet addresses are case-sensitive on Sepolia).
 */
export function hashWalletAddress(walletAddress: string): string {
  return createHash('sha256').update(walletAddress.trim()).digest('hex');
}

/**
 * Hash a Didit session id into the face-blacklist storage form
 * (Sprint 6). The cascade-ban path writes `hashFace(currentSessionId)`
 * into `customer_blacklist.face_hash` so that the NEXT face_search 1:N
 * run — whose result will include the just-banned session as a match —
 * trips a hit when the webhook handler hashes each match's sessionId
 * against this column. Plain SHA-256 with no salt because the session
 * id is already a high-entropy UUID. Trim only — case preserved
 * (Didit emits lowercased UUIDs).
 */
export function hashFace(diditSessionId: string): string {
  return createHash('sha256').update(diditSessionId.trim()).digest('hex');
}

/**
 * Look up a face hash in the blacklist. Returns `true` when at least
 * one row carries the same `face_hash`. Used by the WEBHOOK handler
 * (Sprint 6) to detect a face-match cascade: for each entry in the
 * fresh decision's `face_search` matches, hash the match's
 * `sessionId` and look it up here — a hit means the matched session
 * was banned for fraud and the current attempt MUST cascade-ban.
 */
export async function isFaceBlacklisted(
  db: CrivacyDatabase,
  faceHash: string,
): Promise<boolean> {
  if (faceHash.length === 0) return false;
  const rows = await db
    .select({ id: customerBlacklist.id })
    .from(customerBlacklist)
    .where(eq(customerBlacklist.faceHash, faceHash))
    .limit(1);
  return rows.length > 0;
}

/**
 * Check if a wallet address is blacklisted.
 */
export async function isWalletBlacklisted(
  db: CrivacyDatabase,
  walletAddress: string,
): Promise<boolean> {
  const hash = hashWalletAddress(walletAddress);
  return isBlacklisted(db, null, undefined, hash);
}

/**
 * Remove a blacklist entry by ID. Returns `true` if the row existed
 * and was deleted, `false` if it was not found.
 *
 * Note: removing a blacklist entry does NOT reinstate the customer.
 * An explicit unban operation (setting customer status from `banned`
 * to `suspended`) is a separate step handled by the unban handler.
 */
export async function removeFromBlacklist(
  db: CrivacyDatabase,
  blacklistId: string,
): Promise<boolean> {
  const rows = await db
    .delete(customerBlacklist)
    .where(eq(customerBlacklist.id, blacklistId))
    .returning();
  return rows.length > 0;
}

/**
 * Remove all blacklist entries for a specific customer. Used when
 * unbanning a customer — all associated blacklist entries (email,
 * document, wallet hashes) are cleared so the customer can register
 * again if needed.
 *
 * Returns the number of entries removed.
 */
export async function removeBlacklistByCustomerId(
  db: CrivacyDatabase,
  customerId: string,
): Promise<number> {
  const rows = await db
    .delete(customerBlacklist)
    .where(eq(customerBlacklist.customerId, customerId))
    .returning();
  return rows.length;
}

/**
 * List blacklist entries with cursor-based pagination. Ordered by
 * `createdAt` descending (newest first). The cursor is the `id`
 * of the last entry from the previous page.
 *
 * Returns up to `limit` rows. When fewer rows are returned, there
 * are no more pages.
 */
export async function listBlacklist(
  db: CrivacyDatabase,
  cursor?: string,
  limit = 20,
): Promise<readonly CustomerBlacklistEntry[]> {
  const clampedLimit = Math.min(Math.max(limit, 1), 100);

  if (cursor !== undefined && cursor.length > 0) {
    // Fetch the createdAt of the cursor row to paginate from
    const cursorRows = await db
      .select({ createdAt: customerBlacklist.createdAt })
      .from(customerBlacklist)
      .where(eq(customerBlacklist.id, cursor))
      .limit(1);

    const cursorRow = cursorRows[0];
    if (cursorRow !== undefined) {
      return db
        .select()
        .from(customerBlacklist)
        .where(sql`${customerBlacklist.createdAt} < ${cursorRow.createdAt}`)
        .orderBy(desc(customerBlacklist.createdAt))
        .limit(clampedLimit);
    }
  }

  return db
    .select()
    .from(customerBlacklist)
    .orderBy(desc(customerBlacklist.createdAt))
    .limit(clampedLimit);
}
