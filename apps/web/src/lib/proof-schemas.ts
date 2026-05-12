/**
 * Source for inserting rows into `proof_schemas` (immutable DB table).
 *
 * For each `(chain, version)` pair this module defines:
 *   - the canonical field set + ordering hashed at mint time
 *   - the canonical algorithm identifier
 *   - the auditor-facing docs URL
 *
 * The runtime authority for "what spec was used to compute hash X?"
 * is the DB (`proof_schemas` table, Postgres-trigger-immutable). This
 * code module is the SOURCE for inserting new spec rows on worker
 * boot via {@link seedProofSchemas}. Auditors read DB.
 *
 * **Adding a new verification surface** (wealth, employment, …):
 *   1. add a `WorkflowChain` enum value below
 *   2. add a `PROOF_SCHEMA_DEFS` entry naming the input fields
 *      (canonical-sorted, lexicographic ASCII)
 *   3. add a `mapping.ts` extractor that pulls those fields from
 *      the relevant Didit decision(s)
 *   4. update `content/docs/proof-hash-schema.mdx` (auditor copy)
 *   5. on next worker start, `seedProofSchemas()` INSERTs the new row
 *
 * **Modifying an existing (chain, version) entry is FORBIDDEN.**
 * If a spec needs to change, BUMP THE VERSION (`v1` → `v2`). The new
 * version becomes the default for new mints; old credentials keep
 * their `proof_schema_id` FK to the v1 row, which stays untouched.
 *
 * `seedProofSchemas` enforces this: it diffs each in-memory def
 * against the corresponding DB row and throws if any existing row's
 * `fields_in_order` or `canonical_algo` does not match byte-for-byte.
 *
 * No on-chain contract change is ever required for this surface — the
 * on-chain `proofHash` field stays a single opaque hex string
 * regardless of how many workflow chains compose it.
 *
 * @module
 */

import { eq, and } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { proofSchemas } from '@/lib/db/schema';

/* ---------- Workflow chain enum ---------- */

export const WORKFLOW_CHAINS = Object.freeze([
  'kyc', // Phase 1 single-workflow KYC mint
  'address', // Phase 2 single-workflow address mint (legacy, pre-Sprint-2)
  'kyc+address', // Composite KYC + address mint (Sprint 2+)
  // Future: 'kyc+address+wealth', 'kyc+address+wealth+employment', …
] as const);

export type WorkflowChain = (typeof WORKFLOW_CHAINS)[number];

/* ---------- Spec definitions ---------- */

/**
 * One spec definition. `fieldsInOrder` MUST be canonical-sorted
 * (lexicographic ASCII). Listing them in canonical order in code
 * keeps {@link seedProofSchemas}'s byte-for-byte diff straightforward
 * and makes the docs page mechanically generatable from this array.
 *
 * For composite specs (Sprint 2+), `fieldsInOrder` is a JSON object
 * keyed by sub-document — see the `kyc+address-v1` entry's docblock
 * once Sprint 2 lands.
 */
export interface ProofSchemaDef {
  readonly chain: WorkflowChain;
  readonly version: string;
  readonly fieldsInOrder: ReadonlyArray<string> | Readonly<Record<string, ReadonlyArray<string>>>;
  readonly canonicalAlgo: string;
  readonly sourceDocUrl: string;
}

/**
 * Sprint 1 ships two spec defs: `kyc-v1` + `address-v1`. The composite
 * `kyc+address-v1` def is added in Sprint 2 alongside the
 * `extractCompositeProofInput` extractor in `mapping.ts`.
 *
 * Keep this array in `(chain, version)` ascending order — auditor-
 * facing docs are generated from it and ordering matters for diff
 * stability across PRs.
 */
export const PROOF_SCHEMA_DEFS: readonly ProofSchemaDef[] = Object.freeze([
  {
    chain: 'kyc',
    version: 'v1',
    fieldsInOrder: Object.freeze([
      'dateOfBirth',
      'documentNumber',
      'documentType',
      'firstName',
      'issuingCountry',
      'lastName',
      'sessionId',
      'vendorData',
      'workflowType',
    ] as const),
    canonicalAlgo: 'sortKeys+shortenFloats+sha256',
    sourceDocUrl: '/docs/proof-hash-schema#kyc-v1',
  },
  {
    chain: 'address',
    version: 'v1',
    fieldsInOrder: Object.freeze([
      'addressVerified',
      'country',
      'documentType',
      'sessionId',
      'vendorData',
      'workflowType',
    ] as const),
    canonicalAlgo: 'sortKeys+shortenFloats+sha256',
    sourceDocUrl: '/docs/proof-hash-schema#address-v1',
  },
] as const);

/* ---------- Runtime helpers ---------- */

/**
 * Stable-stringify a `fieldsInOrder` value for byte-for-byte equality
 * comparison against the `jsonb` form Postgres returns. Both arrays
 * and nested objects pass through `JSON.stringify` with no special
 * handling — the in-memory defs are already canonical-sorted, and
 * Postgres `jsonb` round-trips lose key insertion order anyway, so we
 * compare on a normalized representation.
 *
 * Object keys are sorted lexicographically before serialization to
 * remove any insertion-order ambiguity.
 */
function normalizeForCompare(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((v) => JSON.parse(normalizeForCompare(v)) as unknown));
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const normalized: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      normalized[key] = JSON.parse(normalizeForCompare((value as Record<string, unknown>)[key]));
    }
    return JSON.stringify(normalized);
  }
  return JSON.stringify(value);
}

/**
 * On worker startup, ensure every {@link PROOF_SCHEMA_DEFS} entry
 * exists in `proof_schemas`. Missing rows are INSERTed. Existing rows
 * whose `fields_in_order` or `canonical_algo` does NOT match the
 * in-memory def cause an exception — that is the developer's signal
 * to BUMP THE VERSION instead of editing the existing spec.
 *
 * Idempotent — safe to call on every worker boot. Cheap (one SELECT
 * per def, plus N INSERTs where N = number of unseeded defs).
 */
export async function seedProofSchemas(db: CrivacyDatabase): Promise<void> {
  for (const def of PROOF_SCHEMA_DEFS) {
    const existing = await db
      .select()
      .from(proofSchemas)
      .where(and(eq(proofSchemas.chain, def.chain), eq(proofSchemas.version, def.version)))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(proofSchemas).values({
        chain: def.chain,
        version: def.version,
        fieldsInOrder: def.fieldsInOrder as unknown as Record<string, unknown> | unknown[],
        canonicalAlgo: def.canonicalAlgo,
        sourceDocUrl: def.sourceDocUrl,
      });
      continue;
    }

    const row = existing[0]!;
    const dbFields = normalizeForCompare(row.fieldsInOrder);
    const codeFields = normalizeForCompare(def.fieldsInOrder);

    if (dbFields !== codeFields || row.canonicalAlgo !== def.canonicalAlgo) {
      throw new Error(
        `proof_schemas drift detected for (chain=${def.chain}, version=${def.version}). ` +
          `DB row's fields_in_order or canonical_algo does not match the in-memory def. ` +
          `proof_schemas is append-only — bump the version (e.g. v1 → v2) instead of editing. ` +
          `DB.fields_in_order=${dbFields} code.fields_in_order=${codeFields} ` +
          `DB.canonical_algo=${row.canonicalAlgo} code.canonical_algo=${def.canonicalAlgo}`,
      );
    }
  }
}

/**
 * Look up the `proof_schemas.id` for a `(chain, version)` pair. Used
 * by `credential-pipeline-worker` when assembling the
 * `kyc_credentials_meta` insert payload.
 *
 * Throws if the spec is not seeded — never falls back to the latest
 * version, never auto-creates the row. Silent fallback would mint a
 * credential under the wrong spec, breaking auditor reproducibility.
 *
 * Worker boot calls {@link seedProofSchemas} first, so by the time a
 * mint job runs the lookup is guaranteed to hit.
 */
export async function resolveProofSchemaId(
  db: CrivacyDatabase,
  chain: WorkflowChain,
  version: string,
): Promise<string> {
  const rows = await db
    .select({ id: proofSchemas.id })
    .from(proofSchemas)
    .where(and(eq(proofSchemas.chain, chain), eq(proofSchemas.version, version)))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(
      `resolveProofSchemaId: no proof_schemas row for (chain=${chain}, version=${version}). ` +
        `Did seedProofSchemas() run on worker boot? Did you forget to add the def to PROOF_SCHEMA_DEFS?`,
    );
  }
  return rows[0]!.id;
}
