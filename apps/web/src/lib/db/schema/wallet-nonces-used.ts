/**
 * `wallet_nonces_used` — single-use tracker for Ethereum wallet
 * challenge nonces.
 *
 * The wallet login flow mints a short-lived JWT challenge whose
 * payload embeds a random 32-byte nonce. The user's wallet signs
 * that nonce; the server verifies the JWT + the Ed25519 signature,
 * then issues a session. The JWT's `exp` claim gives us a 5-minute
 * window before the challenge is rejected by structural checks —
 * without this table, any `(challenge JWT, signature)` pair that
 * leaks inside that 5-minute window can be replayed to mint another
 * session.
 *
 * The table closes the window: every successful `verify` call
 * INSERTs the nonce; a re-submit collides on the primary key and
 * is rejected before any session is created.
 *
 * Rows are cheap — 32-byte nonce + two timestamps — and expire
 * shortly after the JWT itself, so background cleanup can prune
 * anything older than a few minutes without affecting correctness.
 *
 * @module
 */

import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const walletNoncesUsed = pgTable(
  'wallet_nonces_used',
  {
    /**
     * Hex-encoded 64-character nonce (32 random bytes). Acts as
     * the primary key so atomic `INSERT ... ON CONFLICT DO NOTHING`
     * serves as the replay check.
     */
    nonce: text('nonce').primaryKey(),
    /**
     * When the nonce was first accepted. A replay attempt shows up
     * as a conflict against this row; the stored `used_at` is the
     * original successful use.
     */
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    /**
     * When the nonce becomes safe to delete — matches the challenge
     * JWT's expiration plus a small clock-skew buffer. Cleanup can
     * scan this index to prune aged rows.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('wallet_nonces_used_expires_at_idx').on(table.expiresAt)],
);

export type WalletNonceUsed = typeof walletNoncesUsed.$inferSelect;
export type NewWalletNonceUsed = typeof walletNoncesUsed.$inferInsert;
