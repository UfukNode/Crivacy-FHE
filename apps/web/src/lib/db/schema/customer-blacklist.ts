import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { customers } from './customers';
import { fraudReasonEnum } from './enums';

// ---------------------------------------------------------------------------
// customer_blacklist
// ---------------------------------------------------------------------------

/**
 * `customer_blacklist` — records of permanently banned customers, keyed by
 * SHA-256 hashes of PII (email, document ID) rather than the raw values.
 * This prevents data leaks while still enabling fast O(1) lookups during
 * registration and login.
 *
 * A row is created automatically when the Didit webhook handler detects
 * fraud signals (document tampering, face spoofing, liveness replay), or
 * manually by an admin via the ban endpoint. Removing a row does NOT
 * reinstate the customer — an explicit unban operation is required which
 * sets customer status to `suspended` and requires re-verification.
 *
 * The `email_hash` column is nullable — wallet-only users have no email.
 * `document_hash` is optional because fraud can be detected before a
 * document ID is extracted. `wallet_address_hash` enables blacklisting
 * wallet addresses for wallet-only login users. `face_hash` (Sprint 6)
 * carries the deterministic biometric vector hash so the face-match
 * cascade can reject the next attempt with the same face before
 * Didit is even called.
 */
export const customerBlacklist = pgTable(
  'customer_blacklist',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** SHA-256 hex digest of the lowercased email address (nullable for wallet-only users). */
    emailHash: text('email_hash'),
    /** SHA-256 hex digest of the document ID from Didit decision (nullable). */
    documentHash: text('document_hash'),
    /** SHA-256 hex digest of the wallet address (nullable — only for wallet-linked users). */
    walletAddressHash: text('wallet_address_hash'),
    /**
     * SHA-256 hex digest of the Didit session id whose face was the
     * fraud anchor (Sprint 6). Populated when the cascade-ban path
     * fires on a face_search 1:N hit OR a Didit fraud signal. The
     * gate that uses this column lives in the WEBHOOK handler, not
     * the start-session path: when a fresh decision arrives carrying
     * `face_search` matches, the handler hashes each match's
     * `sessionId` and checks whether any hash hits this column —
     * that's the cascade trigger. Pre-Didit short-circuiting (before
     * the session even reaches Didit) is handled by the separate
     * `ip_abuse_signals` counter, not this column.
     */
    faceHash: text('face_hash'),
    reason: fraudReasonEnum('reason').notNull(),
    /** Origin of the ban: `didit_webhook` for auto-ban, `admin_manual` for human. */
    source: text('source').notNull(),
    /** Reference to the Didit session that triggered the auto-ban (nullable). */
    diditSessionId: text('didit_session_id'),
    /** The customer who was banned (nullable — may be set even for pre-registration blocks). */
    customerId: uuid('customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),
    /** Admin user who performed the manual ban (null for auto-ban). */
    bannedBy: uuid('banned_by'),
    /** Free-text notes for audit trail (admin-provided reason). */
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('customer_blacklist_email_hash_idx').on(table.emailHash),
    index('customer_blacklist_document_hash_idx')
      .on(table.documentHash)
      .where(sql`${table.documentHash} IS NOT NULL`),
    index('customer_blacklist_customer_id_idx').on(table.customerId),
    index('customer_blacklist_wallet_address_hash_idx')
      .on(table.walletAddressHash)
      .where(sql`${table.walletAddressHash} IS NOT NULL`),
    index('customer_blacklist_face_hash_idx')
      .on(table.faceHash)
      .where(sql`${table.faceHash} IS NOT NULL`),
  ],
);

export type CustomerBlacklistEntry = typeof customerBlacklist.$inferSelect;
export type NewCustomerBlacklistEntry = typeof customerBlacklist.$inferInsert;
