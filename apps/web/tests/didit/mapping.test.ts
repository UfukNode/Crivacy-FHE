/**
 * Tests for the decision → flags mapping + proof hash derivation.
 *
 * The mapping layer sits between the Didit wire payload and the
 * Chain credential builder. Every transformation here must be
 * deterministic (same input → same output), pure (no global state),
 * and strict on bad inputs (fail closed with a narrow error code).
 *
 * Covered surfaces:
 *
 *   * `statusToOutcome` — 4 canonical statuses + unknown_status throw
 *   * `reduceOutcomes`  — empty → pending, failed > pending >
 *     manual_review > passed reduction order
 *   * `reduceDecision`  — KYC path sets identity + liveness flags,
 *     Address path sets address flag, non-passed outcomes clear all
 *     booleans, float humanScore clamped to 0..100 integer
 *   * `mergeVerificationFlags` — OR booleans, minimum humanScore,
 *     strictest outcome, cleared-on-fail
 *   * `computeProofHash` — deterministic SHA-256 hex, KYC vs Address
 *     produces different hashes even with identical session_id, strict
 *     mode throws invalid_proof_input on missing fields, lenient mode
 *     hashes anyway
 *   * `detectWorkflowType` — no fail-open branch, always throws
 */

import { describe, expect, it } from 'vitest';

import {
  DiditError,
  computeProofHash,
  detectWorkflowType,
  isDiditErrorWithCode,
  mergeVerificationFlags,
  reduceDecision,
  reduceOutcomes,
  statusToOutcome,
} from '@crivacy-fhe/adapter-didit';
import type { DiditVerificationFlags } from '@crivacy-fhe/adapter-didit';

import {
  FIXTURE_ADDRESS_WORKFLOW_ID,
  FIXTURE_KYC_WORKFLOW_ID,
  buildAddressDecisionPayload,
  buildKycDecisionPayload,
  buildTestConfig,
} from './fixtures';

/* ---------- statusToOutcome ---------- */

describe('statusToOutcome', () => {
  it('maps Approved to passed', () => {
    expect(statusToOutcome('Approved')).toBe('passed');
  });

  it('maps Declined to failed', () => {
    expect(statusToOutcome('Declined')).toBe('failed');
  });

  it('maps In Review to manual_review', () => {
    expect(statusToOutcome('In Review')).toBe('manual_review');
  });

  it('maps In Progress to pending', () => {
    expect(statusToOutcome('In Progress')).toBe('pending');
  });

  it('throws unknown_status on an unrecognized token', () => {
    try {
      statusToOutcome('MaybeApproved');
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'unknown_status')).toBe(true);
    }
  });

  it('throws on an empty string', () => {
    expect(() => statusToOutcome('')).toThrow(DiditError);
  });
});

/* ---------- reduceOutcomes ---------- */

describe('reduceOutcomes', () => {
  it('returns pending on an empty input', () => {
    expect(reduceOutcomes([])).toBe('pending');
  });

  it('returns passed when every outcome is passed', () => {
    expect(reduceOutcomes(['passed', 'passed'])).toBe('passed');
  });

  it('returns failed on any failed outcome (even with passed)', () => {
    expect(reduceOutcomes(['passed', 'failed'])).toBe('failed');
    expect(reduceOutcomes(['failed', 'passed', 'pending'])).toBe('failed');
  });

  it('returns pending on any pending outcome (no failed)', () => {
    expect(reduceOutcomes(['passed', 'pending'])).toBe('pending');
    expect(reduceOutcomes(['manual_review', 'pending'])).toBe('pending');
  });

  it('returns manual_review when pending is absent but manual_review is present', () => {
    expect(reduceOutcomes(['passed', 'manual_review'])).toBe('manual_review');
  });

  it('prioritizes failed over pending, manual_review, passed', () => {
    expect(reduceOutcomes(['failed', 'pending', 'manual_review', 'passed'])).toBe('failed');
  });
});

/* ---------- reduceDecision — KYC ---------- */

describe('reduceDecision — KYC', () => {
  it('sets identity + liveness flags on an approved KYC decision', () => {
    const decision = buildKycDecisionPayload();
    const flags = reduceDecision(decision);
    expect(flags.workflowType).toBe('kyc');
    expect(flags.outcome).toBe('passed');
    expect(flags.humanScore).toBe(95);
    expect(flags.identityVerified).toBe(true);
    expect(flags.livenessVerified).toBe(true);
    expect(flags.addressVerified).toBe(false);
  });

  it('clears all flags when outcome is declined', () => {
    const decision = buildKycDecisionPayload({ status: 'Declined' });
    const flags = reduceDecision(decision);
    expect(flags.outcome).toBe('failed');
    expect(flags.identityVerified).toBe(false);
    expect(flags.livenessVerified).toBe(false);
    expect(flags.addressVerified).toBe(false);
  });

  it('clears all flags when outcome is in review', () => {
    const decision = buildKycDecisionPayload({ status: 'In Review' });
    const flags = reduceDecision(decision);
    expect(flags.outcome).toBe('manual_review');
    expect(flags.identityVerified).toBe(false);
    expect(flags.livenessVerified).toBe(false);
  });

  it('drops identityVerified when document number is missing', () => {
    const decision = buildKycDecisionPayload({
      kyc: {
        documentType: 'PASSPORT',
        documentNumber: null,
        issuingCountry: 'TUR',
        firstName: 'Ada',
        lastName: 'Lovelace',
        dateOfBirth: '1815-12-10',
      },
    });
    const flags = reduceDecision(decision);
    expect(flags.outcome).toBe('passed');
    expect(flags.identityVerified).toBe(false);
    expect(flags.livenessVerified).toBe(true);
  });

  it('drops livenessVerified when liveness.passed is false', () => {
    const decision = buildKycDecisionPayload({
      liveness: { passed: false, score: 40 },
    });
    const flags = reduceDecision(decision);
    expect(flags.livenessVerified).toBe(false);
    expect(flags.identityVerified).toBe(true);
  });

  it('drops livenessVerified when face match fails', () => {
    const decision = buildKycDecisionPayload({
      faceMatch: { passed: false, score: 20 },
    });
    const flags = reduceDecision(decision);
    expect(flags.livenessVerified).toBe(false);
  });

  it('sets livenessVerified when faceMatch is null (no face match in workflow)', () => {
    const decision = buildKycDecisionPayload({ faceMatch: null });
    const flags = reduceDecision(decision);
    expect(flags.livenessVerified).toBe(true);
  });

  it('clamps a humanScore > 100 to 100', () => {
    const decision = buildKycDecisionPayload({ humanScore: 150 });
    const flags = reduceDecision(decision);
    expect(flags.humanScore).toBe(100);
  });

  it('clamps a humanScore < 0 to 0', () => {
    const decision = buildKycDecisionPayload({ humanScore: -5 });
    const flags = reduceDecision(decision);
    expect(flags.humanScore).toBe(0);
  });

  it('clamps NaN / undefined / null humanScore to 0', () => {
    expect(reduceDecision(buildKycDecisionPayload({ humanScore: null })).humanScore).toBe(0);
    expect(reduceDecision(buildKycDecisionPayload({ humanScore: Number.NaN })).humanScore).toBe(0);
  });

  it('rounds a fractional humanScore', () => {
    const decision = buildKycDecisionPayload({ humanScore: 95.6 });
    const flags = reduceDecision(decision);
    expect(flags.humanScore).toBe(96);
  });

  it('returns a frozen flags object', () => {
    const flags = reduceDecision(buildKycDecisionPayload());
    expect(Object.isFrozen(flags)).toBe(true);
  });
});

/* ---------- reduceDecision — Address ---------- */

describe('reduceDecision — Address', () => {
  it('sets addressVerified on an approved Address decision', () => {
    const decision = buildAddressDecisionPayload();
    const flags = reduceDecision(decision);
    expect(flags.workflowType).toBe('address');
    expect(flags.outcome).toBe('passed');
    expect(flags.addressVerified).toBe(true);
    expect(flags.identityVerified).toBe(false);
    expect(flags.livenessVerified).toBe(false);
  });

  it('does not set addressVerified on a declined Address decision', () => {
    const decision = buildAddressDecisionPayload({ status: 'Declined' });
    const flags = reduceDecision(decision);
    expect(flags.outcome).toBe('failed');
    expect(flags.addressVerified).toBe(false);
  });

  it('does not set addressVerified when address block reports unverified', () => {
    const decision = buildAddressDecisionPayload({
      address: { addressVerified: false, documentType: 'UTILITY_BILL', country: 'TUR' },
    });
    const flags = reduceDecision(decision);
    expect(flags.outcome).toBe('passed');
    expect(flags.addressVerified).toBe(false);
  });
});

/* ---------- mergeVerificationFlags ---------- */

describe('mergeVerificationFlags', () => {
  it('merges KYC + Address flags into a single passed result', () => {
    const kyc = reduceDecision(buildKycDecisionPayload());
    const addr = reduceDecision(buildAddressDecisionPayload());
    const merged = mergeVerificationFlags([kyc, addr]);

    expect(merged.outcome).toBe('passed');
    expect(merged.identityVerified).toBe(true);
    expect(merged.livenessVerified).toBe(true);
    expect(merged.addressVerified).toBe(true);
  });

  it('picks the minimum humanScore as the weakest link', () => {
    const kyc = reduceDecision(buildKycDecisionPayload({ humanScore: 95 }));
    const addr = reduceDecision(buildAddressDecisionPayload({ humanScore: 80 }));
    const merged = mergeVerificationFlags([kyc, addr]);
    expect(merged.humanScore).toBe(80);
  });

  it('reduces outcomes via the failed > pending > manual_review > passed rule', () => {
    const kyc = reduceDecision(buildKycDecisionPayload({ status: 'Approved' }));
    const addr = reduceDecision(buildAddressDecisionPayload({ status: 'In Progress' }));
    const merged = mergeVerificationFlags([kyc, addr]);
    expect(merged.outcome).toBe('pending');
    // Outcome is not passed, so flags should be cleared.
    expect(merged.identityVerified).toBe(false);
    expect(merged.livenessVerified).toBe(false);
    expect(merged.addressVerified).toBe(false);
  });

  it('clears flags when the merged outcome is failed', () => {
    const kyc = reduceDecision(buildKycDecisionPayload({ status: 'Declined' }));
    const addr = reduceDecision(buildAddressDecisionPayload({ status: 'Approved' }));
    const merged = mergeVerificationFlags([kyc, addr]);
    expect(merged.outcome).toBe('failed');
    expect(merged.identityVerified).toBe(false);
    expect(merged.livenessVerified).toBe(false);
    expect(merged.addressVerified).toBe(false);
  });

  it('returns a pending zeroed result on an empty array', () => {
    const merged = mergeVerificationFlags([]);
    expect(merged.outcome).toBe('pending');
    expect(merged.humanScore).toBe(0);
    expect(merged.identityVerified).toBe(false);
    expect(merged.livenessVerified).toBe(false);
    expect(merged.addressVerified).toBe(false);
  });

  it('ORs booleans when merging two passed KYC-only sessions', () => {
    const a: DiditVerificationFlags = {
      workflowType: 'kyc',
      outcome: 'passed',
      humanScore: 90,
      identityVerified: true,
      livenessVerified: false,
      addressVerified: false,
    };
    const b: DiditVerificationFlags = {
      workflowType: 'kyc',
      outcome: 'passed',
      humanScore: 92,
      identityVerified: false,
      livenessVerified: true,
      addressVerified: false,
    };
    const merged = mergeVerificationFlags([a, b]);
    expect(merged.outcome).toBe('passed');
    expect(merged.identityVerified).toBe(true);
    expect(merged.livenessVerified).toBe(true);
    expect(merged.humanScore).toBe(90);
  });

  it('returns a frozen merged result', () => {
    const kyc = reduceDecision(buildKycDecisionPayload());
    const addr = reduceDecision(buildAddressDecisionPayload());
    const merged = mergeVerificationFlags([kyc, addr]);
    expect(Object.isFrozen(merged)).toBe(true);
  });
});

/* ---------- computeProofHash ---------- */

describe('computeProofHash — strict mode', () => {
  it('produces a 64-char lowercase hex SHA-256', () => {
    const config = buildTestConfig();
    const hash = computeProofHash(config, buildKycDecisionPayload());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    const config = buildTestConfig();
    const decision = buildKycDecisionPayload();
    const a = computeProofHash(config, decision);
    const b = computeProofHash(config, decision);
    expect(a).toBe(b);
  });

  it('produces different hashes for KYC vs Address on the same session_id', () => {
    const config = buildTestConfig();
    const kyc = buildKycDecisionPayload();
    const addr = buildAddressDecisionPayload();
    const kycHash = computeProofHash(config, kyc);
    const addrHash = computeProofHash(config, addr);
    expect(kycHash).not.toBe(addrHash);
  });

  it('produces different hashes on a different document_number', () => {
    const config = buildTestConfig();
    const a = computeProofHash(
      config,
      buildKycDecisionPayload({
        kyc: {
          documentType: 'PASSPORT',
          documentNumber: 'P000000001',
          issuingCountry: 'TUR',
          firstName: 'Ada',
          lastName: 'Lovelace',
          dateOfBirth: '1815-12-10',
        },
      }),
    );
    const b = computeProofHash(
      config,
      buildKycDecisionPayload({
        kyc: {
          documentType: 'PASSPORT',
          documentNumber: 'P000000002',
          issuingCountry: 'TUR',
          firstName: 'Ada',
          lastName: 'Lovelace',
          dateOfBirth: '1815-12-10',
        },
      }),
    );
    expect(a).not.toBe(b);
  });

  it('throws invalid_proof_input when a KYC required field is missing', () => {
    const config = buildTestConfig({ DIDIT_PROOF_HASH_STRICT: 'true' });
    const decision = buildKycDecisionPayload({
      kyc: {
        documentType: 'PASSPORT',
        documentNumber: null,
        issuingCountry: 'TUR',
        firstName: 'Ada',
        lastName: 'Lovelace',
        dateOfBirth: '1815-12-10',
      },
    });

    try {
      computeProofHash(config, decision);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_proof_input')).toBe(true);
      const context = (err as DiditError).context ?? {};
      const missing = (context as Record<string, unknown>)['missing'] as string[] | undefined;
      expect(missing).toContain('documentNumber');
    }
  });

  it('throws invalid_proof_input listing all missing KYC fields', () => {
    const config = buildTestConfig({ DIDIT_PROOF_HASH_STRICT: 'true' });
    const decision = buildKycDecisionPayload({
      kyc: {
        documentType: null,
        documentNumber: null,
        issuingCountry: null,
        firstName: null,
        lastName: null,
        dateOfBirth: null,
      },
    });

    try {
      computeProofHash(config, decision);
      expect.unreachable();
    } catch (err) {
      const context = (err as DiditError).context ?? {};
      const missing = (context as Record<string, unknown>)['missing'] as string[] | undefined;
      // `issuingCountry` is intentionally NOT in the strict gate —
      // Didit's V3 wire format leaves it nullable+optional and the
      // OCR pipeline returns `null` for several common document
      // types (e.g. TR Identity Cards). The hash payload still
      // includes the field (substituted with `''` on null) so the
      // proof remains deterministic.
      expect(missing).toEqual(
        expect.arrayContaining([
          'documentNumber',
          'firstName',
          'lastName',
          'dateOfBirth',
        ]),
      );
      expect(missing).not.toContain('issuingCountry');
    }
  });

  it('throws invalid_proof_input when an Address required field is missing', () => {
    const config = buildTestConfig({ DIDIT_PROOF_HASH_STRICT: 'true' });
    const decision = buildAddressDecisionPayload({
      address: { addressVerified: true, documentType: null, country: null },
    });
    try {
      computeProofHash(config, decision);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_proof_input')).toBe(true);
    }
  });
});

describe('computeProofHash — lenient mode', () => {
  it('hashes even when KYC fields are missing', () => {
    const config = buildTestConfig({ DIDIT_PROOF_HASH_STRICT: 'false' });
    const decision = buildKycDecisionPayload({
      kyc: {
        documentType: null,
        documentNumber: null,
        issuingCountry: null,
        firstName: null,
        lastName: null,
        dateOfBirth: null,
      },
    });
    const hash = computeProofHash(config, decision);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ---------- detectWorkflowType ---------- */

describe('detectWorkflowType', () => {
  it('returns kyc for the configured KYC id', () => {
    const config = buildTestConfig();
    expect(detectWorkflowType(config, FIXTURE_KYC_WORKFLOW_ID)).toBe('kyc');
  });

  it('returns address for the configured Address id', () => {
    const config = buildTestConfig();
    expect(detectWorkflowType(config, FIXTURE_ADDRESS_WORKFLOW_ID)).toBe('address');
  });

  it('throws unknown_workflow on an unknown id (no fail-open branch)', () => {
    const config = buildTestConfig();
    try {
      detectWorkflowType(config, '00000000-0000-0000-0000-000000000000');
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'unknown_workflow')).toBe(true);
    }
  });

  it('still throws even when config has fail-closed disabled (no fail-open path)', () => {
    const config = buildTestConfig({ DIDIT_FAIL_CLOSED_ON_UNKNOWN_WORKFLOW: 'false' });
    expect(() => detectWorkflowType(config, '00000000-0000-0000-0000-000000000000')).toThrow(
      DiditError,
    );
  });
});
