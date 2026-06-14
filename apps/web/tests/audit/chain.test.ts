/**
 * Tests for the tamper-evident audit-log hash chain.
 *
 * The chain is a read-time construction — it is not persisted on
 * the row itself, so the test suite only needs pure fixtures. These
 * tests cover:
 *
 *   * `computeAuditChain` returns the correct number of entries with
 *     strictly-ascending ids.
 *   * Empty input → empty chain, tail = seed.
 *   * Seed validation (64-char hex).
 *   * `verifyAuditChain` passes on the output of `computeAuditChain`.
 *   * Any mutation of a row after compute → `chain_broken`.
 *   * Any mutation of a `prevHash` / `contentHash` → `chain_broken`.
 *   * Row re-ordering → `chain_broken`.
 *   * `canonicalRowString` is deterministic and contains the field
 *     values in declared order.
 *   * Two different non-trivial meta payloads produce different
 *     content hashes even when other fields are identical.
 *   * `CHAIN_GENESIS_HASH` is 64 zero hex chars and validates.
 *   * `CHAIN_FORMAT_VERSION` is pinned.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AuditError,
  CHAIN_FIELDS,
  CHAIN_FORMAT_VERSION,
  CHAIN_GENESIS_HASH,
  canonicalRowString,
  computeAuditChain,
  verifyAuditChain,
} from '@/lib/audit';

import { buildPersistedRow } from './fixtures';

/**
 * Test helper: narrow `T | undefined` to `T` with a descriptive
 * error if the value is missing. Used to avoid non-null assertions
 * (`!`) on array indexing while keeping the tamper-detection tests
 * concise.
 */
function assertExists<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`test setup: ${label} is undefined`);
  }
  return value;
}

describe('CHAIN_FORMAT_VERSION', () => {
  it('is pinned to 1', () => {
    expect(CHAIN_FORMAT_VERSION).toBe(1);
  });
});

describe('CHAIN_GENESIS_HASH', () => {
  it('is exactly 64 zero hex chars', () => {
    expect(CHAIN_GENESIS_HASH).toBe('0'.repeat(64));
    expect(CHAIN_GENESIS_HASH).toHaveLength(64);
  });
});

describe('CHAIN_FIELDS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(CHAIN_FIELDS)).toBe(true);
  });

  it('includes every persisted column in the expected order', () => {
    expect([...CHAIN_FIELDS]).toEqual([
      'id',
      'actorKind',
      'actorId',
      'actorLabel',
      'firmId',
      'action',
      'targetKind',
      'targetId',
      'targetRef',
      'ip',
      'userAgent',
      'requestId',
      'meta',
      'ts',
    ]);
  });
});

describe('computeAuditChain', () => {
  it('returns an empty chain for zero rows', () => {
    const result = computeAuditChain([]);
    expect(result.entries).toHaveLength(0);
    expect(result.tailHash).toBe(CHAIN_GENESIS_HASH);
    expect(result.version).toBe(CHAIN_FORMAT_VERSION);
  });

  it('computes a one-entry chain over a single row', () => {
    const row = buildPersistedRow({ id: 1 });
    const result = computeAuditChain([row]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.prevHash).toBe(CHAIN_GENESIS_HASH);
    expect(result.entries[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tailHash).toBe(result.entries[0]?.contentHash);
  });

  it('threads prevHash through a multi-row chain', () => {
    const rows = [
      buildPersistedRow({ id: 1 }),
      buildPersistedRow({ id: 2 }),
      buildPersistedRow({ id: 3 }),
    ];
    const result = computeAuditChain(rows);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.prevHash).toBe(CHAIN_GENESIS_HASH);
    expect(result.entries[1]?.prevHash).toBe(result.entries[0]?.contentHash);
    expect(result.entries[2]?.prevHash).toBe(result.entries[1]?.contentHash);
    expect(result.tailHash).toBe(result.entries[2]?.contentHash);
  });

  it('each contentHash is a 64-char hex string', () => {
    const rows = Array.from({ length: 5 }, (_, i) => buildPersistedRow({ id: i + 1 }));
    const result = computeAuditChain(rows);
    for (const entry of result.entries) {
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('respects a custom seed hash', () => {
    const seed = 'a'.repeat(64);
    const row = buildPersistedRow({ id: 1 });
    const result = computeAuditChain([row], seed);
    expect(result.entries[0]?.prevHash).toBe(seed);
  });

  it('rejects a seed that is not 64 hex chars', () => {
    expect(() => computeAuditChain([], 'short')).toThrow(AuditError);
    expect(() => computeAuditChain([], 'z'.repeat(64))).toThrow(AuditError);
    expect(() => computeAuditChain([], 'A'.repeat(64))).toThrow(AuditError);
  });

  it('throws invalid_chain_seed error code on bad seed', () => {
    try {
      computeAuditChain([], 'bad');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditError);
      expect((err as AuditError).code).toBe('invalid_chain_seed');
    }
  });

  it('rejects rows that are not strictly ascending by id', () => {
    const rows = [buildPersistedRow({ id: 2 }), buildPersistedRow({ id: 1 })];
    expect(() => computeAuditChain(rows)).toThrow(AuditError);
  });

  it('rejects rows with duplicate id', () => {
    const rows = [buildPersistedRow({ id: 5 }), buildPersistedRow({ id: 5 })];
    expect(() => computeAuditChain(rows)).toThrow(/ascending/);
  });

  it('content hash changes when meta changes', () => {
    const a = computeAuditChain([buildPersistedRow({ id: 1, meta: { x: 1 } })]);
    const b = computeAuditChain([buildPersistedRow({ id: 1, meta: { x: 2 } })]);
    expect(a.entries[0]?.contentHash).not.toBe(b.entries[0]?.contentHash);
  });

  it('content hash is stable for meta key reordering', () => {
    // Canonical JSON sorts keys, so these should produce the same hash.
    const a = computeAuditChain([buildPersistedRow({ id: 1, meta: { b: 2, a: 1 } })]);
    const b = computeAuditChain([buildPersistedRow({ id: 1, meta: { a: 1, b: 2 } })]);
    expect(a.entries[0]?.contentHash).toBe(b.entries[0]?.contentHash);
  });

  it('content hash differs when ts differs', () => {
    const a = computeAuditChain([
      buildPersistedRow({ id: 1, ts: new Date('2026-04-10T00:00:00.000Z') }),
    ]);
    const b = computeAuditChain([
      buildPersistedRow({ id: 1, ts: new Date('2026-04-10T00:00:01.000Z') }),
    ]);
    expect(a.entries[0]?.contentHash).not.toBe(b.entries[0]?.contentHash);
  });
});

describe('verifyAuditChain — round trip', () => {
  it('verifies the output of computeAuditChain', () => {
    const rows = Array.from({ length: 5 }, (_, i) => buildPersistedRow({ id: i + 1 }));
    const chain = computeAuditChain(rows);
    expect(() => verifyAuditChain(chain.entries)).not.toThrow();
  });

  it('verifies an empty chain', () => {
    expect(() => verifyAuditChain([])).not.toThrow();
  });

  it('verifies with a custom seed', () => {
    const seed = 'f'.repeat(64);
    const rows = [buildPersistedRow({ id: 1 })];
    const chain = computeAuditChain(rows, seed);
    expect(() => verifyAuditChain(chain.entries, seed)).not.toThrow();
  });

  it('rejects a mismatched seed', () => {
    const rows = [buildPersistedRow({ id: 1 })];
    const chain = computeAuditChain(rows);
    expect(() => verifyAuditChain(chain.entries, 'a'.repeat(64))).toThrow(AuditError);
  });

  it('rejects an invalid seed', () => {
    expect(() => verifyAuditChain([], 'short')).toThrow(/seed/);
  });
});

describe('verifyAuditChain — tamper detection', () => {
  it('detects a mutated row (meta changed)', () => {
    const rows = [buildPersistedRow({ id: 1, meta: { x: 1 } })];
    const chain = computeAuditChain(rows);
    // Swap in a row with different meta but keep the same prevHash /
    // contentHash as the original chain.
    const entry0 = assertExists(chain.entries[0], 'entry 0');
    const row0 = assertExists(rows[0], 'row 0');
    const tampered = [
      {
        ...entry0,
        row: { ...row0, meta: { x: 2 } },
      },
    ];
    expect(() => verifyAuditChain(tampered)).toThrow(/contentHash/);
  });

  it('detects a mutated row (action changed)', () => {
    const rows = [buildPersistedRow({ id: 1, action: 'firm_user.login.success' })];
    const chain = computeAuditChain(rows);
    const entry0 = assertExists(chain.entries[0], 'entry 0');
    const row0 = assertExists(rows[0], 'row 0');
    const tampered = [
      {
        ...entry0,
        row: { ...row0, action: 'firm_user.login.failed' as const },
      },
    ];
    expect(() => verifyAuditChain(tampered)).toThrow(AuditError);
  });

  it('detects a mutated prevHash', () => {
    const rows = [buildPersistedRow({ id: 1 }), buildPersistedRow({ id: 2 })];
    const chain = computeAuditChain(rows);
    const entry0 = assertExists(chain.entries[0], 'entry 0');
    const entry1 = assertExists(chain.entries[1], 'entry 1');
    const tampered = [
      entry0,
      {
        ...entry1,
        prevHash: '0'.repeat(64),
      },
    ];
    expect(() => verifyAuditChain(tampered)).toThrow(/prevHash/);
  });

  it('detects a mutated contentHash', () => {
    const rows = [buildPersistedRow({ id: 1 })];
    const chain = computeAuditChain(rows);
    const entry0 = assertExists(chain.entries[0], 'entry 0');
    const tampered = [
      {
        ...entry0,
        contentHash: 'f'.repeat(64),
      },
    ];
    expect(() => verifyAuditChain(tampered)).toThrow(/contentHash/);
  });

  it('detects rows re-ordered (prev hash mismatch)', () => {
    // When entries are swapped, the verifier's rolling hash state
    // still starts at the genesis seed. Entry[1].prevHash is the
    // hash of entry[0], which is not the seed, so the prevHash
    // rolling-state check fires before the ascending-id check.
    const rows = [buildPersistedRow({ id: 1 }), buildPersistedRow({ id: 2 })];
    const chain = computeAuditChain(rows);
    const entry0 = assertExists(chain.entries[0], 'entry 0');
    const entry1 = assertExists(chain.entries[1], 'entry 1');
    const reordered = [entry1, entry0];
    expect(() => verifyAuditChain(reordered)).toThrow(/prevHash/);
  });

  it('detects non-ascending ids directly', () => {
    // Build a chain that starts at the high id so the rolling-state
    // prevHash check passes on entry[0] and the ascending-id check
    // fires on entry[1].
    const rows = [buildPersistedRow({ id: 10 }), buildPersistedRow({ id: 11 })];
    const chain = computeAuditChain(rows);
    const entry0 = assertExists(chain.entries[0], 'entry 0');
    const entry1 = assertExists(chain.entries[1], 'entry 1');
    // Swap in a lower-id entry for slot 1 while keeping its prevHash
    // equal to the first entry's contentHash.
    const tampered = [
      entry0,
      {
        ...entry1,
        row: { ...entry1.row, id: 5 },
      },
    ];
    expect(() => verifyAuditChain(tampered)).toThrow(/ascending/);
  });

  it('chain_broken is the error code on content mismatch', () => {
    const rows = [buildPersistedRow({ id: 1 })];
    const chain = computeAuditChain(rows);
    const entry0 = assertExists(chain.entries[0], 'entry 0');
    const tampered = [
      {
        ...entry0,
        contentHash: '0'.repeat(64),
      },
    ];
    try {
      verifyAuditChain(tampered);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditError);
      expect((err as AuditError).code).toBe('chain_broken');
    }
  });
});

describe('canonicalRowString', () => {
  it('is deterministic for the same row', () => {
    const row = buildPersistedRow({ id: 1 });
    const a = canonicalRowString(CHAIN_GENESIS_HASH, row);
    const b = canonicalRowString(CHAIN_GENESIS_HASH, row);
    expect(a).toBe(b);
  });

  it('includes the format version prefix', () => {
    const row = buildPersistedRow({ id: 1 });
    const str = canonicalRowString(CHAIN_GENESIS_HASH, row);
    expect(str).toContain(`version=${CHAIN_FORMAT_VERSION}`);
  });

  it('includes the prev hash', () => {
    const row = buildPersistedRow({ id: 1 });
    const str = canonicalRowString(CHAIN_GENESIS_HASH, row);
    expect(str).toContain(`prev=${CHAIN_GENESIS_HASH}`);
  });

  it('contains every CHAIN_FIELDS key', () => {
    const row = buildPersistedRow({ id: 1 });
    const str = canonicalRowString(CHAIN_GENESIS_HASH, row);
    for (const field of CHAIN_FIELDS) {
      expect(str).toContain(`${field}=`);
    }
  });

  it('uses ISO 8601 format for ts', () => {
    const ts = new Date('2026-04-10T09:30:00.000Z');
    const row = buildPersistedRow({ id: 1, ts });
    const str = canonicalRowString(CHAIN_GENESIS_HASH, row);
    expect(str).toContain('ts=2026-04-10T09:30:00.000Z');
  });

  it('uses canonical JSON (sorted keys) for meta', () => {
    const rowA = buildPersistedRow({ id: 1, meta: { b: 2, a: 1 } });
    const rowB = buildPersistedRow({ id: 1, meta: { a: 1, b: 2 } });
    const a = canonicalRowString(CHAIN_GENESIS_HASH, rowA);
    const b = canonicalRowString(CHAIN_GENESIS_HASH, rowB);
    expect(a).toBe(b);
  });

  it('produces the same sha256 as computeAuditChain', () => {
    const row = buildPersistedRow({ id: 1 });
    const canonical = canonicalRowString(CHAIN_GENESIS_HASH, row);
    const expected = createHash('sha256').update(canonical).digest('hex');
    const chain = computeAuditChain([row]);
    expect(chain.entries[0]?.contentHash).toBe(expected);
  });

  it('serializes nullable fields as empty strings', () => {
    const row = buildPersistedRow({
      id: 1,
      actorId: null,
      firmId: null,
      targetKind: null,
      targetId: null,
      targetRef: null,
      ip: null,
      userAgent: null,
      requestId: null,
    });
    const str = canonicalRowString(CHAIN_GENESIS_HASH, row);
    expect(str).toContain('actorId=|');
    expect(str).toContain('firmId=|');
    expect(str).toContain('ip=|');
  });
});

describe('chain seed continuity across exports', () => {
  it('two sequential exports can chain via tailHash', () => {
    const batch1 = [buildPersistedRow({ id: 1 }), buildPersistedRow({ id: 2 })];
    const batch2 = [buildPersistedRow({ id: 3 }), buildPersistedRow({ id: 4 })];
    const export1 = computeAuditChain(batch1);
    const export2 = computeAuditChain(batch2, export1.tailHash);

    expect(export2.entries[0]?.prevHash).toBe(export1.tailHash);
    // And verifying both separately works:
    expect(() => verifyAuditChain(export1.entries)).not.toThrow();
    expect(() => verifyAuditChain(export2.entries, export1.tailHash)).not.toThrow();
  });
});
