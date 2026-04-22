/**
 * Catalog of Didit warning risk codes — single source of truth.
 *
 * Every code here is sourced verbatim from Didit's public docs:
 *   - 74_liveness-warnings.md
 *   - 75_face-match-warnings.md
 *   - 77_face-search-warnings.md
 *   - 46_id-verification-warnings.md
 *
 * Schema-level enum-locking on `WarningBlock.risk` is intentionally
 * avoided — Didit ships new codes between API versions. This catalog
 * lists the codes we recognize for decline-reason priority and Sprint 6
 * face-match cascade logic. Unknown codes pass through and are surfaced
 * as the generic "verification failed" failure_reason.
 *
 * Importers (single source — never inline these strings elsewhere):
 *   - `lib/didit/decline-reason.ts` — priority-rank to derive the human
 *     `failure_reason` we persist on `customer_kyc_sessions`.
 *   - `lib/fraud/face-match.ts` — cascade trigger detection.
 *   - `lib/didit/session.ts::hydrateDecisionResponse` — projection layer.
 */

export const DIDIT_RISK = {
  // --- Biometric / Face (Liveness + Face Search 1:N) ---
  DUPLICATED_FACE: 'DUPLICATED_FACE',
  POSSIBLE_DUPLICATED_FACE: 'POSSIBLE_DUPLICATED_FACE',
  FACE_IN_BLOCKLIST: 'FACE_IN_BLOCKLIST',
  POSSIBLE_FACE_IN_BLOCKLIST: 'POSSIBLE_FACE_IN_BLOCKLIST',
  LIVENESS_FACE_ATTACK: 'LIVENESS_FACE_ATTACK',
  LOW_LIVENESS_SCORE: 'LOW_LIVENESS_SCORE',
  LOW_FACE_QUALITY: 'LOW_FACE_QUALITY',
  LOW_FACE_MATCH_SIMILARITY: 'LOW_FACE_MATCH_SIMILARITY',
  LOW_FRONT_CAMERA_FACE_MATCH_SIMILARITY: 'LOW_FRONT_CAMERA_FACE_MATCH_SIMILARITY',
  MULTIPLE_FACES_DETECTED: 'MULTIPLE_FACES_DETECTED',
  NO_FACE_DETECTED: 'NO_FACE_DETECTED',
  NO_REFERENCE_IMAGE: 'NO_REFERENCE_IMAGE',
  HIGH_FACE_LUMINANCE: 'HIGH_FACE_LUMINANCE',
  LOW_FACE_LUMINANCE: 'LOW_FACE_LUMINANCE',

  // --- ID Verification: duplicate / blocklist ---
  POSSIBLE_DUPLICATED_USER: 'POSSIBLE_DUPLICATED_USER',
  ID_DOCUMENT_IN_BLOCKLIST: 'ID_DOCUMENT_IN_BLOCKLIST',

  // --- ID Verification: tampering / spoof ---
  PORTRAIT_MANIPULATION_DETECTED: 'PORTRAIT_MANIPULATION_DETECTED',
  PRINTED_COPY_DETECTED: 'PRINTED_COPY_DETECTED',
  SCREEN_CAPTURE_DETECTED: 'SCREEN_CAPTURE_DETECTED',

  // --- ID Verification: data inconsistency ---
  DATA_INCONSISTENT: 'DATA_INCONSISTENT',
  ID_VERIFICATION_DATA_MISMATCH_BETWEEN_DOCUMENTS:
    'ID_VERIFICATION_DATA_MISMATCH_BETWEEN_DOCUMENTS',
  MRZ_AND_DATA_EXTRACTED_FROM_OCR_NOT_SAME: 'MRZ_AND_DATA_EXTRACTED_FROM_OCR_NOT_SAME',
  DOCUMENT_NAME_DIFFERENT_FROM_OTHER_APPROVED_DOCUMENTS:
    'DOCUMENT_NAME_DIFFERENT_FROM_OTHER_APPROVED_DOCUMENTS',

  // --- ID Verification: document validity ---
  DOCUMENT_EXPIRED: 'DOCUMENT_EXPIRED',
  DOCUMENT_NOT_SUPPORTED_FOR_APPLICATION: 'DOCUMENT_NOT_SUPPORTED_FOR_APPLICATION',
  COULD_NOT_RECOGNIZE_DOCUMENT: 'COULD_NOT_RECOGNIZE_DOCUMENT',
  COULD_NOT_DETECT_DOCUMENT_TYPE: 'COULD_NOT_DETECT_DOCUMENT_TYPE',
  DOCUMENT_SIDES_MISMATCH: 'DOCUMENT_SIDES_MISMATCH',

  // --- ID Verification: OCR / parse ---
  BARCODE_NOT_DETECTED: 'BARCODE_NOT_DETECTED',
  BARCODE_VALIDATION_FAILED: 'BARCODE_VALIDATION_FAILED',
  MRZ_NOT_DETECTED: 'MRZ_NOT_DETECTED',
  MRZ_VALIDATION_FAILED: 'MRZ_VALIDATION_FAILED',
  QR_NOT_DETECTED: 'QR_NOT_DETECTED',
  QR_VALIDATION_FAILED: 'QR_VALIDATION_FAILED',
  PORTRAIT_IMAGE_NOT_DETECTED: 'PORTRAIT_IMAGE_NOT_DETECTED',
  NAME_NOT_DETECTED: 'NAME_NOT_DETECTED',
  DATE_OF_BIRTH_NOT_DETECTED: 'DATE_OF_BIRTH_NOT_DETECTED',
  EXPIRATION_DATE_NOT_DETECTED: 'EXPIRATION_DATE_NOT_DETECTED',
  DOCUMENT_NUMBER_NOT_DETECTED: 'DOCUMENT_NUMBER_NOT_DETECTED',
  DOCUMENT_NUMBER_FORMAT_MISMATCH: 'DOCUMENT_NUMBER_FORMAT_MISMATCH',
  PERSONAL_NUMBER_FORMAT_MISMATCH: 'PERSONAL_NUMBER_FORMAT_MISMATCH',
  INVALID_DATE: 'INVALID_DATE',
  UNPARSED_ADDRESS: 'UNPARSED_ADDRESS',

  // --- ID Verification: expected_details mismatch (operator-supplied) ---
  COUNTRY_MISMATCH_WITH_PROVIDED: 'COUNTRY_MISMATCH_WITH_PROVIDED',
  DOB_MISMATCH_WITH_PROVIDED: 'DOB_MISMATCH_WITH_PROVIDED',
  FULL_NAME_MISMATCH_WITH_PROVIDED: 'FULL_NAME_MISMATCH_WITH_PROVIDED',
  GENDER_MISMATCH_WITH_PROVIDED: 'GENDER_MISMATCH_WITH_PROVIDED',
  IDENTIFICATION_NUMBER_MISMATCH_WITH_PROVIDED:
    'IDENTIFICATION_NUMBER_MISMATCH_WITH_PROVIDED',
  NATIONALITY_MISMATCH_WITH_PROVIDED: 'NATIONALITY_MISMATCH_WITH_PROVIDED',

  // --- ID Verification: eligibility ---
  MINIMUM_AGE_NOT_MET: 'MINIMUM_AGE_NOT_MET',

  // --- IP / Location (info-level, never a decline reason on its own) ---
  DUPLICATED_IP_ADDRESS: 'DUPLICATED_IP_ADDRESS',
} as const;

export type DiditRiskCode = (typeof DIDIT_RISK)[keyof typeof DIDIT_RISK];

/**
 * Feature names per `WarningBlock.feature` and the `node_id` block
 * suffix (e.g. `feature_liveness`, `feature_ocr`). Sourced from Didit's
 * documented feature catalog.
 */
export const DIDIT_FEATURE = {
  ID_VERIFICATION: 'ID_VERIFICATION',
  LIVENESS: 'LIVENESS',
  FACE_MATCH: 'FACE_MATCH',
  FACE_SEARCH: 'FACE_SEARCH',
  POA: 'POA',
  AML: 'AML',
  IP_ANALYSIS: 'IP_ANALYSIS',
  LOCATION: 'LOCATION',
  AGE_ESTIMATION: 'AGE_ESTIMATION',
  DATABASE_VALIDATION: 'DATABASE_VALIDATION',
  EMAIL_VERIFICATION: 'EMAIL_VERIFICATION',
  PHONE_VERIFICATION: 'PHONE_VERIFICATION',
  NFC: 'NFC',
} as const;

export type DiditFeature = (typeof DIDIT_FEATURE)[keyof typeof DIDIT_FEATURE];

/**
 * Decline-reason priority — when a session is `Declined`, multiple
 * warnings can fire across blocks. The reason code we surface to the
 * user (and on `customer_kyc_sessions.failure_reason`) should be the
 * highest-priority one. Lower index = higher priority.
 *
 * Priority rationale:
 *   1. Biometric duplicate / blocklist — Sprint 6 cascade triggers.
 *      The human story is "you've been here before".
 *   2. Document duplicate / blocklist — same family, weaker signal.
 *   3. Spoof / tampering — fraud signals on the biometric / document.
 *   4. Cross-document inconsistency — fraud signal across documents.
 *   5. Document validity — recoverable with the right document.
 *   6. Liveness / Face match score — recoverable, retry-friendly.
 *   7. OCR / parse — recoverable with better-quality capture.
 *   8. Operator `expected_details` mismatch — policy decision.
 *   9. Eligibility — final gate (e.g. MINIMUM_AGE_NOT_MET).
 *
 * `DUPLICATED_IP_ADDRESS` is excluded — info-level, never a decline
 * reason on its own.
 */
export const DIDIT_DECLINE_REASON_PRIORITY: readonly DiditRiskCode[] = [
  // 1. Biometric duplicate / blocklist
  DIDIT_RISK.DUPLICATED_FACE,
  DIDIT_RISK.POSSIBLE_DUPLICATED_FACE,
  DIDIT_RISK.FACE_IN_BLOCKLIST,
  DIDIT_RISK.POSSIBLE_FACE_IN_BLOCKLIST,
  // 2. Document duplicate / blocklist
  DIDIT_RISK.POSSIBLE_DUPLICATED_USER,
  DIDIT_RISK.ID_DOCUMENT_IN_BLOCKLIST,
  // 3. Spoof / tampering
  DIDIT_RISK.LIVENESS_FACE_ATTACK,
  DIDIT_RISK.PORTRAIT_MANIPULATION_DETECTED,
  DIDIT_RISK.PRINTED_COPY_DETECTED,
  DIDIT_RISK.SCREEN_CAPTURE_DETECTED,
  // 4. Cross-document inconsistency
  DIDIT_RISK.DATA_INCONSISTENT,
  DIDIT_RISK.ID_VERIFICATION_DATA_MISMATCH_BETWEEN_DOCUMENTS,
  DIDIT_RISK.MRZ_AND_DATA_EXTRACTED_FROM_OCR_NOT_SAME,
  DIDIT_RISK.DOCUMENT_NAME_DIFFERENT_FROM_OTHER_APPROVED_DOCUMENTS,
  // 5. Document validity
  DIDIT_RISK.DOCUMENT_EXPIRED,
  DIDIT_RISK.DOCUMENT_NOT_SUPPORTED_FOR_APPLICATION,
  DIDIT_RISK.COULD_NOT_RECOGNIZE_DOCUMENT,
  DIDIT_RISK.COULD_NOT_DETECT_DOCUMENT_TYPE,
  DIDIT_RISK.DOCUMENT_SIDES_MISMATCH,
  // 6. Liveness / Face match — quality + score
  DIDIT_RISK.LOW_LIVENESS_SCORE,
  DIDIT_RISK.LOW_FACE_MATCH_SIMILARITY,
  DIDIT_RISK.LOW_FRONT_CAMERA_FACE_MATCH_SIMILARITY,
  DIDIT_RISK.LOW_FACE_QUALITY,
  DIDIT_RISK.MULTIPLE_FACES_DETECTED,
  DIDIT_RISK.NO_FACE_DETECTED,
  DIDIT_RISK.NO_REFERENCE_IMAGE,
  DIDIT_RISK.HIGH_FACE_LUMINANCE,
  DIDIT_RISK.LOW_FACE_LUMINANCE,
  // 7. OCR / parse
  DIDIT_RISK.MRZ_NOT_DETECTED,
  DIDIT_RISK.MRZ_VALIDATION_FAILED,
  DIDIT_RISK.BARCODE_NOT_DETECTED,
  DIDIT_RISK.BARCODE_VALIDATION_FAILED,
  DIDIT_RISK.QR_NOT_DETECTED,
  DIDIT_RISK.QR_VALIDATION_FAILED,
  DIDIT_RISK.PORTRAIT_IMAGE_NOT_DETECTED,
  DIDIT_RISK.NAME_NOT_DETECTED,
  DIDIT_RISK.DATE_OF_BIRTH_NOT_DETECTED,
  DIDIT_RISK.EXPIRATION_DATE_NOT_DETECTED,
  DIDIT_RISK.DOCUMENT_NUMBER_NOT_DETECTED,
  DIDIT_RISK.DOCUMENT_NUMBER_FORMAT_MISMATCH,
  DIDIT_RISK.PERSONAL_NUMBER_FORMAT_MISMATCH,
  DIDIT_RISK.INVALID_DATE,
  DIDIT_RISK.UNPARSED_ADDRESS,
  // 8. expected_details mismatch
  DIDIT_RISK.FULL_NAME_MISMATCH_WITH_PROVIDED,
  DIDIT_RISK.DOB_MISMATCH_WITH_PROVIDED,
  DIDIT_RISK.IDENTIFICATION_NUMBER_MISMATCH_WITH_PROVIDED,
  DIDIT_RISK.COUNTRY_MISMATCH_WITH_PROVIDED,
  DIDIT_RISK.NATIONALITY_MISMATCH_WITH_PROVIDED,
  DIDIT_RISK.GENDER_MISMATCH_WITH_PROVIDED,
  // 9. Eligibility
  DIDIT_RISK.MINIMUM_AGE_NOT_MET,
];

/**
 * Fraud-signal codes — risk codes that, when present, ALWAYS trigger
 * the Sprint 6 cascade path (madde 5/6): cascade ban + face_hash
 * blacklist + tx archive + revoke webhooks. These are the codes that
 * unambiguously indicate fraud (spoof, document forgery, blocklist
 * hit) — no further logic needed.
 *
 * `DUPLICATED_FACE` and `POSSIBLE_DUPLICATED_USER` are NOT in this
 * list because they are duplicate-detection signals, not fraud
 * signals: cascade decision for those depends on the matched
 * account's status (banned / locked / clean), which is a separate
 * lookup. See `lib/fraud/face-match.ts::evaluateFaceMatch`.
 */
export const DIDIT_FRAUD_SIGNAL_CODES: readonly DiditRiskCode[] = [
  DIDIT_RISK.LIVENESS_FACE_ATTACK,
  DIDIT_RISK.PORTRAIT_MANIPULATION_DETECTED,
  DIDIT_RISK.PRINTED_COPY_DETECTED,
  DIDIT_RISK.SCREEN_CAPTURE_DETECTED,
  DIDIT_RISK.FACE_IN_BLOCKLIST,
  DIDIT_RISK.ID_DOCUMENT_IN_BLOCKLIST,
];

/**
 * Duplicate-detection codes — present in the warning surface alongside
 * a populated `matches[]` array. Triggers Sprint 6's "is the matched
 * account banned/locked/clean?" lookup; cascade only fires if the
 * matched account is banned (madde 5) or one of the fraud-signal
 * codes above also fires (madde 6).
 */
export const DIDIT_DUPLICATE_DETECTION_CODES: readonly DiditRiskCode[] = [
  DIDIT_RISK.DUPLICATED_FACE,
  DIDIT_RISK.POSSIBLE_DUPLICATED_FACE,
  DIDIT_RISK.POSSIBLE_DUPLICATED_USER,
];

/**
 * Set form for O(1) `has()` membership checks.
 */
export const DIDIT_FRAUD_SIGNAL_SET: ReadonlySet<DiditRiskCode> = new Set(
  DIDIT_FRAUD_SIGNAL_CODES,
);
export const DIDIT_DUPLICATE_DETECTION_SET: ReadonlySet<DiditRiskCode> = new Set(
  DIDIT_DUPLICATE_DETECTION_CODES,
);
