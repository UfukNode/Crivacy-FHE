/**
 * Decision → internal outcome mapping + proof-hash derivation.
 *
 * This module owns every transformation between Didit's wire-level
 * decision payload and the shapes the credential builder
 * consumes:
 *
 *   * **`statusToOutcome`** — map Didit's four status tokens to the
 *     internal `InternalVerificationOutcome` union. Unknown statuses
 *     fail closed with `DiditError('unknown_status', …)` so an
 *     upstream rename does not silently pass a verification.
 *
 *   * **`reduceDecision`** — turn a parsed `DiditDecisionPayload`
 *     into `DiditVerificationFlags`. The flags pair identity +
 *     liveness + address booleans with the numeric human score and
 *     the reduced outcome. `identityVerified` / `livenessVerified`
 *     only set for a KYC-workflow decision; `addressVerified` only
 *     for an address-workflow decision. Consumers merge the flags
 *     from both sessions before calling `fhe.createCredential`.
 *
 *   * **`mergeVerificationFlags`** — combine flags from multiple
 *     sessions into a single set for the credential. Merge rules:
 *
 *       * `outcome` reduces across sessions via `reduceOutcomes`
 *         (strictest wins: any `failed` → failed, any `pending` or
 *         `manual_review` → that; all `passed` → passed).
 *       * Boolean flags are ORed — each session contributes the
 *         subset of fields it is authoritative for.
 *       * `humanScore` is the minimum across sessions (caller's
 *         choice: the weakest link wins, we do not average).
 *       * `workflowType` is dropped — the merged set represents the
 *         combined credential, not a single workflow.
 *
 *   * **`computeProofHash`** — build a deterministic SHA-256 hex
 *     digest from the identity fields we care about. Feeds the
 *     `io.crivacy/proofHash` claim on chain `chain.VC.Credential` contract.
 *     Strict mode (`config.proofHashStrict`) requires the full set
 *     of fields for the decision's workflow type and throws
 *     `invalid_proof_input` on any missing field. Lenient mode
 *     substitutes empty strings so a partial decision still produces
 *     a deterministic hash — used in dev fixtures only.
 *
 * Every derivation uses the canonical JSON pipeline from
 * `canonical.ts` (`shortenFloats` + `sortKeys` + `stringify`) so a
 * field-order swap or a whole-number float coercion upstream cannot
 * change the resulting hash.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical';
import type { DiditConfig } from './config';
import { DiditError } from './errors';
import { DIDIT_STATUS } from './types';
import type {
  DiditDecisionPayload,
  DiditDecisionStatus,
  DiditVerificationFlags,
  DiditWorkflowType,
  InternalVerificationOutcome,
} from './types';

/* ---------- Status → outcome ---------- */

/**
 * Lookup table from Didit status token to internal outcome. Kept as
 * a frozen record so the compiler can narrow `status` at call sites
 * and a new status is an obvious TypeScript error instead of a
 * runtime fallthrough.
 */
const STATUS_TO_OUTCOME: Readonly<Record<DiditDecisionStatus, InternalVerificationOutcome>> =
  Object.freeze({
    [DIDIT_STATUS.APPROVED]: 'passed',
    [DIDIT_STATUS.DECLINED]: 'failed',
    [DIDIT_STATUS.IN_REVIEW]: 'manual_review',
    [DIDIT_STATUS.IN_PROGRESS]: 'pending',
    // Pending-side states added when DiditDecisionStatus was widened
    // to mirror Didit's full 9-status catalogue. `Not Started` and
    // `Resubmitted` both leave the customer with action remaining
    // (open the link / redo flagged steps) so they reduce to the
    // generic `pending` outcome — handlers that need to differentiate
    // (e.g. resubmission UI) branch on the raw status string before
    // calling `statusToOutcome`.
    [DIDIT_STATUS.NOT_STARTED]: 'pending',
    [DIDIT_STATUS.RESUBMITTED]: 'pending',
    // Terminal failure variants. `Expired` and `Abandoned` cover
    // user-side time-outs; `Kyc Expired` covers post-approval policy
    // expiry. All three are unrecoverable without a fresh session
    // and reduce to `failed` for the high-level outcome reducer.
    [DIDIT_STATUS.EXPIRED]: 'failed',
    [DIDIT_STATUS.ABANDONED]: 'failed',
    [DIDIT_STATUS.KYC_EXPIRED]: 'failed',
  });

/**
 * Map a Didit status to our internal outcome. Throws
 * `DiditError('unknown_status', …)` on any status we did not
 * configure so an upstream rename surfaces immediately.
 */
export function statusToOutcome(status: string): InternalVerificationOutcome {
  const mapped = STATUS_TO_OUTCOME[status as DiditDecisionStatus];
  if (mapped === undefined) {
    throw new DiditError('unknown_status', `Didit returned an unrecognized status: ${status}`, {
      context: { status },
    });
  }
  return mapped;
}

/* ---------- Outcome reducer ---------- */

/**
 * Combine multiple outcomes into a single authoritative outcome.
 * Reduction order, strictest first:
 *
 *   1. `failed`        — any failure poisons the merge
 *   2. `pending`       — any pending session keeps the merge pending
 *   3. `manual_review` — any manual_review leaves the merge in review
 *   4. `passed`        — only when every session is passed
 *
 * Empty input returns `pending` — callers that need a different
 * default (e.g. `failed` on no data) must guard before calling.
 */
export function reduceOutcomes(
  outcomes: readonly InternalVerificationOutcome[],
): InternalVerificationOutcome {
  if (outcomes.length === 0) {
    return 'pending';
  }
  if (outcomes.includes('failed')) {
    return 'failed';
  }
  if (outcomes.includes('pending')) {
    return 'pending';
  }
  if (outcomes.includes('manual_review')) {
    return 'manual_review';
  }
  return 'passed';
}

/* ---------- Decision → flags ---------- */

/**
 * Clamp a numeric score into the 0..100 integer range we store on
 * the credential. Didit already validates 0..100 at the schema layer,
 * but upstream rounding can produce 99.6 — which we want to round
 * down to 99 on the credential rather than carrying a float.
 */
function clampScore(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 100) {
    return 100;
  }
  return Math.round(value);
}

/**
 * Build `DiditVerificationFlags` from a parsed decision. Identity /
 * liveness flags are only considered under the KYC workflow, and
 * address flag only under the Address workflow — the flags struct
 * carries the subset each session is authoritative for.
 *
 * A non-`passed` outcome clears every boolean. This is intentional:
 * a `manual_review` KYC session must not propagate `identityVerified`
 * to the credential builder even if the document fields are present.
 * The merge layer re-evaluates once both sessions have landed.
 */
export function reduceDecision(decision: DiditDecisionPayload): DiditVerificationFlags {
  const outcome = statusToOutcome(decision.status);
  const humanScore = clampScore(decision.humanScore);

  if (outcome !== 'passed') {
    return Object.freeze({
      workflowType: decision.workflowType,
      outcome,
      humanScore,
      identityVerified: false,
      livenessVerified: false,
      addressVerified: false,
    });
  }

  if (decision.workflowType === 'kyc') {
    const identityVerified =
      decision.kyc !== null &&
      typeof decision.kyc.documentNumber === 'string' &&
      decision.kyc.documentNumber.length > 0;
    const livenessVerified =
      decision.liveness?.passed === true &&
      (decision.faceMatch === null || decision.faceMatch.passed);
    return Object.freeze({
      workflowType: 'kyc',
      outcome,
      humanScore,
      identityVerified,
      livenessVerified,
      addressVerified: false,
    });
  }

  // address workflow
  const addressVerified = decision.address?.addressVerified === true;
  return Object.freeze({
    workflowType: 'address',
    outcome,
    humanScore,
    identityVerified: false,
    livenessVerified: false,
    addressVerified,
  });
}

/* ---------- Flags merge ---------- */

/**
 * Merged flags shape. `workflowType` is dropped because the merged
 * record combines multiple workflows; `humanScore` is the minimum of
 * the inputs so the weakest link wins.
 */
export interface MergedVerificationFlags {
  readonly outcome: InternalVerificationOutcome;
  readonly humanScore: number;
  readonly identityVerified: boolean;
  readonly livenessVerified: boolean;
  readonly addressVerified: boolean;
}

/**
 * Merge a set of flags produced by multiple sessions (typically one
 * KYC + one Address). See the module doc for the merge rules.
 */
export function mergeVerificationFlags(
  flags: readonly DiditVerificationFlags[],
): MergedVerificationFlags {
  if (flags.length === 0) {
    return Object.freeze({
      outcome: 'pending',
      humanScore: 0,
      identityVerified: false,
      livenessVerified: false,
      addressVerified: false,
    });
  }

  const outcome = reduceOutcomes(flags.map((f) => f.outcome));
  let humanScore = 100;
  let identityVerified = false;
  let livenessVerified = false;
  let addressVerified = false;

  for (const f of flags) {
    if (f.humanScore < humanScore) {
      humanScore = f.humanScore;
    }
    if (f.identityVerified) {
      identityVerified = true;
    }
    if (f.livenessVerified) {
      livenessVerified = true;
    }
    if (f.addressVerified) {
      addressVerified = true;
    }
  }

  // If outcome is not `passed`, clear every boolean to match the
  // per-decision rule in `reduceDecision` — a failing session must
  // not bleed flags into the merged credential.
  if (outcome !== 'passed') {
    return Object.freeze({
      outcome,
      humanScore,
      identityVerified: false,
      livenessVerified: false,
      addressVerified: false,
    });
  }

  return Object.freeze({
    outcome,
    humanScore,
    identityVerified,
    livenessVerified,
    addressVerified,
  });
}

/* ---------- Proof hash ---------- */

/**
 * Fields required for a KYC-workflow proof hash in strict mode.
 * Picked to be the minimum set that uniquely identifies a document
 * AND a person across two verifications — `documentNumber +
 * documentType` pin the artefact, `firstName + lastName +
 * dateOfBirth` pin the human. A null on any of these means Didit
 * could not extract the core identity, which is a real KYC failure.
 *
 * `issuingCountry` is intentionally NOT in this gate. Didit's V3
 * wire format leaves it nullable+optional (see `schemas.ts:193`)
 * and in practice returns `null` for several document types whose
 * MRZ / OCR pipeline does not surface the country code (notably
 * TR Identity Cards). The field still participates in the proof
 * hash payload — `extractKycProofInput` substitutes `''` on null,
 * which produces a deterministic and verifiable digest. An auditor
 * replaying the hash against `proof_schemas.fields_in_order` will
 * reproduce the same value because the schema lists `issuingCountry`
 * in its canonical order; the strict-mode gate is a quality bar on
 * the EXTRACT step, not on the hash spec, so removing it here does
 * not require a `proof_schemas` version bump.
 */
const KYC_REQUIRED_FIELDS: readonly (keyof KycProofInput)[] = [
  'documentNumber',
  'firstName',
  'lastName',
  'dateOfBirth',
];

/**
 * Fields required for an Address-workflow proof hash in strict mode.
 * The country is always present when `addressVerified` is true;
 * the document type is carried for audit.
 */
const ADDRESS_REQUIRED_FIELDS: readonly (keyof AddressProofInput)[] = ['country', 'documentType'];

/**
 * Canonical KYC input the proof hash is derived from. All fields
 * are strings because the hash input must be deterministic and
 * `null` vs `undefined` vs missing-key all collapse to `""` in
 * strict mode validation (which throws before hashing).
 */
interface KycProofInput {
  readonly workflowType: 'kyc';
  readonly sessionId: string;
  readonly vendorData: string;
  readonly documentType: string;
  readonly documentNumber: string;
  readonly issuingCountry: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
}

/**
 * Canonical Address input the proof hash is derived from.
 */
interface AddressProofInput {
  readonly workflowType: 'address';
  readonly sessionId: string;
  readonly vendorData: string;
  readonly addressVerified: boolean;
  readonly documentType: string;
  readonly country: string;
}

/**
 * Shape union. The hash payload depends on the workflow type so a
 * KYC hash and an Address hash cannot collide even on a crafted
 * input — the workflow type is always the first sorted key.
 */
type ProofInput = KycProofInput | AddressProofInput;

/**
 * Pull the KYC proof fields out of a decision, substituting empty
 * strings for any missing field. Strict validation happens after
 * this extraction so the error message names the exact missing
 * fields.
 */
function extractKycProofInput(decision: DiditDecisionPayload): KycProofInput {
  const kyc = decision.kyc ?? null;
  return {
    workflowType: 'kyc',
    sessionId: decision.sessionId,
    vendorData: decision.vendorData,
    documentType: kyc?.documentType ?? '',
    documentNumber: kyc?.documentNumber ?? '',
    issuingCountry: kyc?.issuingCountry ?? '',
    firstName: kyc?.firstName ?? '',
    lastName: kyc?.lastName ?? '',
    dateOfBirth: kyc?.dateOfBirth ?? '',
  };
}

/**
 * Pull the Address proof fields out of a decision, with the same
 * empty-string fallbacks as the KYC path.
 */
function extractAddressProofInput(decision: DiditDecisionPayload): AddressProofInput {
  const address = decision.address ?? null;
  return {
    workflowType: 'address',
    sessionId: decision.sessionId,
    vendorData: decision.vendorData,
    addressVerified: address?.addressVerified ?? false,
    documentType: address?.documentType ?? '',
    country: address?.country ?? '',
  };
}

/**
 * Find any empty-string KYC fields from the strict requirement set.
 * Returns the list of missing field names so `computeProofHash` can
 * construct a single informative error message.
 */
function findMissingKycFields(input: KycProofInput): readonly string[] {
  const missing: string[] = [];
  for (const key of KYC_REQUIRED_FIELDS) {
    if (input[key].length === 0) {
      missing.push(key);
    }
  }
  return missing;
}

/**
 * Same as `findMissingKycFields`, for the Address workflow.
 */
function findMissingAddressFields(input: AddressProofInput): readonly string[] {
  const missing: string[] = [];
  for (const key of ADDRESS_REQUIRED_FIELDS) {
    const value = input[key];
    if (typeof value !== 'string' || value.length === 0) {
      missing.push(key);
    }
  }
  return missing;
}

/**
 * Compute the deterministic SHA-256 hex digest the credential
 * stores as `proofHash`. The digest input is the canonical JSON form
 * of the per-workflow proof payload, so two decisions for the same
 * document produce the same hash regardless of field order or
 * upstream float formatting.
 *
 * Strict mode (the production default) throws
 * `DiditError('invalid_proof_input', …)` when any required field is
 * missing. Lenient mode is reserved for tests + local fixtures and
 * is opted into via `config.proofHashStrict = false`.
 */
export function computeProofHash(config: DiditConfig, decision: DiditDecisionPayload): string {
  const input: ProofInput =
    decision.workflowType === 'kyc'
      ? extractKycProofInput(decision)
      : extractAddressProofInput(decision);

  if (config.proofHashStrict) {
    const missing =
      input.workflowType === 'kyc' ? findMissingKycFields(input) : findMissingAddressFields(input);
    if (missing.length > 0) {
      throw new DiditError(
        'invalid_proof_input',
        `Cannot compute proof hash: ${decision.workflowType} decision missing required fields [${missing.join(', ')}].`,
        {
          context: {
            workflowType: decision.workflowType,
            missing,
          },
        },
      );
    }
  }

  let canonical: string;
  try {
    canonical = canonicalJson(input);
  } catch (err) {
    throw new DiditError(
      'invalid_proof_input',
      'Failed to canonicalize Didit proof input for hashing.',
      { cause: err, context: { workflowType: decision.workflowType } },
    );
  }

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/* ---------- Workflow detection ---------- */

/**
 * Narrow helper that returns the literal workflow type for a given
 * workflow id, or throws `unknown_workflow`. Unlike
 * `session.resolveWorkflowType`, this helper has no fail-open
 * branch — it is used by the mapping layer, which must always
 * agree with the webhook layer on the workflow type.
 */
export function detectWorkflowType(config: DiditConfig, workflowId: string): DiditWorkflowType {
  if (workflowId === config.kycWorkflowId) {
    return 'kyc';
  }
  if (workflowId === config.addressWorkflowId) {
    return 'address';
  }
  throw new DiditError(
    'unknown_workflow',
    `Workflow id does not match KYC or Address: ${workflowId}`,
    { context: { workflowId } },
  );
}
