import { describe, expect, it } from 'vitest';

import {
  PROOF_SCHEMA_DEFS,
  WORKFLOW_CHAINS,
  type WorkflowChain,
} from '@/lib/proof-schemas';

/**
 * Regression guard for the canonical proof-hash schema definitions.
 *
 * These tests pin three invariants that the auditor reproducibility
 * story RELIES on:
 *
 *   1. The set of recognized workflow chains is stable. Adding a new
 *      chain is allowed (the set grows); silently removing or
 *      renaming an existing chain breaks every credential whose
 *      `proof_schemas` row references it.
 *
 *   2. Every PROOF_SCHEMA_DEFS entry uses a chain value present in
 *      WORKFLOW_CHAINS. A drift between the two would let a worker
 *      mint under a chain that the auditor docs do not enumerate.
 *
 *   3. The flat `fieldsInOrder` arrays are canonical-sorted
 *      (lexicographic ASCII). The hash math depends on this — a typo
 *      that ships an unsorted array would produce a hash that does
 *      not match what the canonical reproducer computes.
 *
 * The seeded DB rows are immutable (Postgres trigger blocks UPDATE +
 * DELETE) so the only way these defs and the DB can disagree is if
 * a developer EDITS an existing entry instead of bumping the version.
 * `seedProofSchemas` catches that drift at boot — these tests catch
 * it at PR review time.
 */

describe('PROOF_SCHEMA_DEFS — auditor reproducibility invariants', () => {
  it('every def chain is a recognized WorkflowChain', () => {
    const chains = new Set<WorkflowChain>(WORKFLOW_CHAINS);
    for (const def of PROOF_SCHEMA_DEFS) {
      expect(chains.has(def.chain)).toBe(true);
    }
  });

  it('every (chain, version) pair is unique', () => {
    const seen = new Set<string>();
    for (const def of PROOF_SCHEMA_DEFS) {
      const key = `${def.chain}@${def.version}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('flat fieldsInOrder arrays are canonical-sorted (lexicographic ASCII)', () => {
    for (const def of PROOF_SCHEMA_DEFS) {
      if (Array.isArray(def.fieldsInOrder)) {
        const sorted = [...def.fieldsInOrder].sort();
        expect(def.fieldsInOrder).toEqual(sorted);
      }
    }
  });

  it('canonicalAlgo is set on every def', () => {
    for (const def of PROOF_SCHEMA_DEFS) {
      expect(def.canonicalAlgo.length).toBeGreaterThan(0);
    }
  });

  it('sourceDocUrl is set on every def (auditor needs the spec link)', () => {
    for (const def of PROOF_SCHEMA_DEFS) {
      expect(def.sourceDocUrl.length).toBeGreaterThan(0);
    }
  });

  it('kyc-v1 spec includes the documented field set', () => {
    const kyc = PROOF_SCHEMA_DEFS.find((d) => d.chain === 'kyc' && d.version === 'v1');
    expect(kyc).toBeDefined();
    expect(kyc!.fieldsInOrder).toEqual([
      'dateOfBirth',
      'documentNumber',
      'documentType',
      'firstName',
      'issuingCountry',
      'lastName',
      'sessionId',
      'vendorData',
      'workflowType',
    ]);
  });

  it('address-v1 spec includes the documented field set', () => {
    const address = PROOF_SCHEMA_DEFS.find((d) => d.chain === 'address' && d.version === 'v1');
    expect(address).toBeDefined();
    expect(address!.fieldsInOrder).toEqual([
      'addressVerified',
      'country',
      'documentType',
      'sessionId',
      'vendorData',
      'workflowType',
    ]);
  });
});
