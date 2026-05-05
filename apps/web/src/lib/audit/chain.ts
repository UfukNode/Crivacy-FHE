/**
 * Tamper-evident hash chain for audit exports.
 *
 * The `audit_log` schema does **not** store a `prev_hash` /
 * `content_hash` pair on each row. Computing the chain at INSERT
 * time is expensive (requires a row lock spanning the head pointer
 * and the new row) and blocks horizontal scaling. Instead, the chain
 * is computed at **export time** over the canonical row order
 * (`id ASC`) with a configurable seed.
 *
 * This is sufficient for the compliance guarantee because:
 *
 *   1. Exports are signed by the operator (step 30) — a mutation
 *      applied *after* an export was taken would be detected when
 *      the next export's prev_hash of the first row fails to match
 *      the previous export's tail hash.
 *   2. Exports are append-only and backed up off-site, so the
 *      operator cannot quietly rewrite history without losing the
 *      off-site signature chain.
 *   3. Within a single export, the chain lets the auditor verify
 *      row-by-row integrity without trusting the operator's DB.
 *
 * `computeAuditChain` is a pure function over a list of row-like
 * inputs. `verifyAuditChain` re-computes the chain and compares it
 * to a supplied list of `(prevHash, contentHash)` tuples.
 *
 * Canonical serialization:
 *
 *   1. Extract the fields in a fixed order (see `CHAIN_FIELDS`).
 *   2. Convert `Date` to ISO 8601 UTC (`.toISOString()`).
 *   3. Convert `meta` to canonical JSON (keys sorted, no whitespace).
 *   4. Concatenate with ASCII `|` separators.
 *   5. Hash with SHA-256 + prev_hash.
 *
 * The format is versioned via `CHAIN_FORMAT_VERSION`. If we ever
 * change the canonical form we bump the version and store it
 * alongside the export for verifier compatibility.
 */

import { createHash } from 'node:crypto';

import { AuditError } from './errors';
import type { PersistedAuditRow } from './writer';

/** Version tag stored alongside the chain. Bump on format changes. */
export const CHAIN_FORMAT_VERSION = 1 as const;

/** Genesis prev_hash — 32 zero bytes, hex-encoded. */
export const CHAIN_GENESIS_HASH = '0'.repeat(64);

/** Ordered field names included in the content hash. */
export const CHAIN_FIELDS = Object.freeze([
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
] as const);

export interface ChainEntry {
  readonly row: PersistedAuditRow;
  readonly prevHash: string;
  readonly contentHash: string;
}

export interface ChainResult {
  readonly entries: readonly ChainEntry[];
  /** Tail hash — becomes the `prevHash` seed for the next export. */
  readonly tailHash: string;
  readonly version: typeof CHAIN_FORMAT_VERSION;
}

/**
 * Compute the hash chain over a list of persisted rows. Rows are
 * NOT reordered; the caller is responsible for passing them in
 * `id ASC` order (export pipeline does this).
 *
 * `seedHash` defaults to the genesis hash on first export. On
 * subsequent exports, pass the tail hash of the previous export so
 * the chain is continuous.
 */
export function computeAuditChain(
  rows: readonly PersistedAuditRow[],
  seedHash: string = CHAIN_GENESIS_HASH,
): ChainResult {
  if (!isValidHexHash(seedHash)) {
    throw new AuditError('invalid_chain_seed', 'seedHash must be a 64-char hex string', {
      context: { length: seedHash.length },
    });
  }
  const entries: ChainEntry[] = [];
  let prev = seedHash;
  let lastId = -Number.MAX_SAFE_INTEGER;
  for (const row of rows) {
    if (row.id <= lastId) {
      throw new AuditError('chain_broken', 'rows are not sorted by id ascending', {
        context: { previousId: lastId, currentId: row.id },
      });
    }
    lastId = row.id;
    const contentHash = hashRow(prev, row);
    entries.push(Object.freeze({ row, prevHash: prev, contentHash }));
    prev = contentHash;
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    tailHash: prev,
    version: CHAIN_FORMAT_VERSION,
  });
}

/**
 * Verify a pre-computed chain by re-hashing each row and comparing
 * to the supplied entries. Throws `AuditError` with `chain_broken`
 * on the first mismatch; returns silently on success.
 *
 * The operation is O(n) in the number of rows and allocates one
 * `sha256` state per row. For a typical yearly export (~1M rows
 * for a high-traffic firm) it runs in ~1s on modest hardware.
 */
export function verifyAuditChain(
  entries: readonly ChainEntry[],
  seedHash: string = CHAIN_GENESIS_HASH,
): void {
  if (!isValidHexHash(seedHash)) {
    throw new AuditError('invalid_chain_seed', 'seedHash must be a 64-char hex string');
  }
  let prev = seedHash;
  let lastId = -Number.MAX_SAFE_INTEGER;
  for (const entry of entries) {
    if (entry.row.id <= lastId) {
      throw new AuditError('chain_broken', 'entries are not sorted by id ascending', {
        context: { previousId: lastId, currentId: entry.row.id },
      });
    }
    lastId = entry.row.id;
    if (entry.prevHash !== prev) {
      throw new AuditError('chain_broken', 'prevHash does not match rolling state', {
        context: { rowId: entry.row.id, expected: prev, found: entry.prevHash },
      });
    }
    const expected = hashRow(prev, entry.row);
    if (expected !== entry.contentHash) {
      throw new AuditError('chain_broken', 'contentHash does not match recomputed value', {
        context: { rowId: entry.row.id, expected, found: entry.contentHash },
      });
    }
    prev = entry.contentHash;
  }
}

/**
 * Build the canonical content string for a single row, given the
 * current prev hash. Exported for tests that pin the canonical
 * format.
 */
export function canonicalRowString(prevHash: string, row: PersistedAuditRow): string {
  const parts: string[] = [`version=${String(CHAIN_FORMAT_VERSION)}`, `prev=${prevHash}`];
  for (const field of CHAIN_FIELDS) {
    parts.push(`${field}=${canonicalField(row, field)}`);
  }
  return parts.join('|');
}

function canonicalField(row: PersistedAuditRow, field: (typeof CHAIN_FIELDS)[number]): string {
  switch (field) {
    case 'id':
      return String(row.id);
    case 'actorKind':
      return row.actorKind;
    case 'actorId':
      return row.actorId ?? '';
    case 'actorLabel':
      return row.actorLabel;
    case 'firmId':
      return row.firmId ?? '';
    case 'action':
      return row.action;
    case 'targetKind':
      return row.targetKind ?? '';
    case 'targetId':
      return row.targetId ?? '';
    case 'targetRef':
      return row.targetRef ?? '';
    case 'ip':
      return row.ip ?? '';
    case 'userAgent':
      return row.userAgent ?? '';
    case 'requestId':
      return row.requestId ?? '';
    case 'meta':
      return canonicalJson(row.meta);
    case 'ts':
      return row.ts.toISOString();
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

function hashRow(prevHash: string, row: PersistedAuditRow): string {
  const canonical = canonicalRowString(prevHash, row);
  return createHash('sha256').update(canonical).digest('hex');
}

function isValidHexHash(value: string): boolean {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}
