// @vitest-environment node
/**
 * `claimWalletNonce` — replay-protection contract.
 *
 * The helper sits between the Ed25519 signature check and the
 * session-creating branches of `POST /api/customer/auth/wallet/verify`.
 * A pair of `(challenge JWT, signature)` that leaks inside the JWT's
 * 5-minute TTL cannot be replayed because the nonce-used table has
 * a primary-key collision on the second INSERT.
 *
 * These tests pin the contract at the SQL interaction level — we
 * stub `db.execute` and assert on:
 *
 *   * the first call inserts the nonce and returns `true`
 *   * a second call with the same nonce returns `false` (SQL's
 *     `ON CONFLICT DO NOTHING RETURNING` path: zero rows)
 *   * the caller never has to inspect SQL state directly
 */

import { describe, expect, it, vi } from 'vitest';

import { claimWalletNonce } from '@/lib/customer/evm-wallet';
import type { CrivacyDatabase } from '@/lib/db/client';

function buildDb(resultsInOrder: ReadonlyArray<{ rows: Array<{ nonce: string }> }>): {
  db: CrivacyDatabase;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn();
  for (const r of resultsInOrder) {
    execute.mockResolvedValueOnce(r);
  }
  execute.mockResolvedValue({ rows: [] });
  return { db: { execute } as unknown as CrivacyDatabase, execute };
}

const NONCE_A = 'a'.repeat(64);
const NONCE_B = 'b'.repeat(64);

describe('claimWalletNonce — replay protection', () => {
  it('returns true when the INSERT wrote a fresh row', async () => {
    const { db, execute } = buildDb([{ rows: [{ nonce: NONCE_A }] }]);

    const result = await claimWalletNonce(db, NONCE_A, new Date('2026-04-22T00:00:00.000Z'));

    expect(result).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns false when the nonce already existed (ON CONFLICT DO NOTHING yielded zero rows)', async () => {
    const { db } = buildDb([{ rows: [] }]);

    const result = await claimWalletNonce(db, NONCE_A, new Date('2026-04-22T00:00:00.000Z'));

    expect(result).toBe(false);
  });

  it('issues exactly one INSERT per claim attempt', async () => {
    // The helper must be a single DB round-trip per attempt — an
    // atomic `INSERT ... ON CONFLICT` — rather than a
    // SELECT-then-INSERT that opens a race window.
    const { db, execute } = buildDb([{ rows: [{ nonce: NONCE_A }] }]);

    await claimWalletNonce(db, NONCE_A, new Date('2026-04-22T00:00:00.000Z'));

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('operates independently per nonce — second distinct nonce after one used is still a fresh claim', async () => {
    const { db } = buildDb([
      { rows: [{ nonce: NONCE_A }] }, // first nonce inserted fresh
      { rows: [{ nonce: NONCE_B }] }, // different nonce also fresh
    ]);

    const firstResult = await claimWalletNonce(db, NONCE_A, new Date('2026-04-22T00:00:00.000Z'));
    const secondResult = await claimWalletNonce(db, NONCE_B, new Date('2026-04-22T00:00:00.000Z'));

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(true);
  });
});
