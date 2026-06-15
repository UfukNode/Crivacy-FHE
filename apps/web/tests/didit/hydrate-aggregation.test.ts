/**
 * Tests for the Sprint 6 cross-block aggregation in
 * `hydrateDecisionResponse` — pins that:
 *
 *   - `faceSearchMatches[]` is populated from BOTH
 *     `liveness_checks[].matches[]` (face-side hits) AND
 *     `id_verifications[].matches[]` (document-side hits) and tagged
 *     with the originating `source`.
 *   - `warnings[]` is flattened across every per-feature block plus
 *     `ip_analyses[].warnings[]` so the priority resolver in
 *     `decline-reason.ts` does not have to re-walk the raw payload.
 *   - `ipAnalyses[]` projects every capture (Didit emits one per
 *     unique device fingerprint when the session bounced from
 *     desktop to phone).
 *   - `failureReasonCode` / `failureReasonText` are derived via
 *     `resolveDeclineReason` over the flattened warnings.
 *
 * The fixture under "Sprint 6 — real Didit declined-by-duplicate"
 * mirrors the actual production payload observed when the user's
 * face matched a previously-approved session
 * (`farukest5` → matches `crivacytest`'s session). It is the
 * regression pin for the bug where a high liveness score (97.73)
 * was projecting `passed: false` without surfacing the cause.
 */

import { describe, expect, it } from 'vitest';

import { hydrateDecisionResponse } from '@crivacy-fhe/adapter-didit/session';
import { DIDIT_RISK } from '@crivacy-fhe/adapter-didit/risk-codes';
import type { DecisionResponse } from '@crivacy-fhe/adapter-didit/schemas';

import { buildTestConfig } from './fixtures';

const FIXTURE_KYC_WORKFLOW = '2ab9f298-699c-4b2c-9ce9-6246c17c6c25';
const FIXTURE_VENDOR_DATA = 'vendor-test-faruk';
const FIXTURE_SESSION_ID = '48017c03-f8ef-4bf9-ab34-1275dd8a10e5';
const FIXTURE_MATCHED_SESSION_ID = 'a8baa82b-bda4-4b30-addc-392274dcd8f4';

const buildConfig = () => buildTestConfig({ DIDIT_KYC_WORKFLOW_ID: FIXTURE_KYC_WORKFLOW });

describe('hydrateDecisionResponse — Sprint 6 cross-block aggregation', () => {
  it('returns empty arrays when the payload has no matches/warnings/ip_analyses', () => {
    const raw: DecisionResponse = {
      session_id: FIXTURE_SESSION_ID,
      workflow_id: FIXTURE_KYC_WORKFLOW,
      vendor_data: FIXTURE_VENDOR_DATA,
      status: 'Approved',
      id_verifications: [{ status: 'Approved' }],
      liveness_checks: [{ status: 'Approved', score: 99 }],
      face_matches: [{ status: 'Approved', score: 96 }],
    };

    const result = hydrateDecisionResponse(buildConfig(), raw);

    expect(result.faceSearchMatches).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ipAnalyses).toEqual([]);
    expect(result.failureReasonCode).toBeNull();
    expect(result.failureReasonText).toBeNull();
  });

  it('aggregates face_search matches from BOTH liveness and id_verifications surfaces', () => {
    const raw: DecisionResponse = {
      session_id: FIXTURE_SESSION_ID,
      workflow_id: FIXTURE_KYC_WORKFLOW,
      vendor_data: FIXTURE_VENDOR_DATA,
      status: 'Declined',
      id_verifications: [
        {
          status: 'Declined',
          matches: [
            {
              session_id: FIXTURE_MATCHED_SESSION_ID,
              vendor_data: '{"customerId":"id-prev","type":"customer"}',
              status: 'Approved',
              is_blocklisted: false,
              session_number: 21,
            },
          ],
        },
      ],
      liveness_checks: [
        {
          status: 'Declined',
          score: 97,
          matches: [
            {
              session_id: FIXTURE_MATCHED_SESSION_ID,
              vendor_data: '{"customerId":"id-prev","type":"customer"}',
              status: 'Approved',
              is_blocklisted: false,
              similarity_percentage: 86.04,
              session_number: 21,
            },
          ],
        },
      ],
    };

    const result = hydrateDecisionResponse(buildConfig(), raw);

    expect(result.faceSearchMatches).toHaveLength(2);
    const livenessMatch = result.faceSearchMatches.find(
      (m) => m.source === 'liveness',
    );
    const idMatch = result.faceSearchMatches.find(
      (m) => m.source === 'id_verification',
    );
    expect(livenessMatch?.sessionId).toBe(FIXTURE_MATCHED_SESSION_ID);
    expect(livenessMatch?.similarityPercentage).toBe(86.04);
    expect(idMatch?.sessionId).toBe(FIXTURE_MATCHED_SESSION_ID);
    expect(idMatch?.similarityPercentage).toBeNull(); // ID side has no similarity
  });

  it('flattens warnings across all blocks and tags feature', () => {
    const raw: DecisionResponse = {
      session_id: FIXTURE_SESSION_ID,
      workflow_id: FIXTURE_KYC_WORKFLOW,
      vendor_data: FIXTURE_VENDOR_DATA,
      status: 'Declined',
      id_verifications: [
        {
          status: 'Declined',
          warnings: [
            {
              feature: 'ID_VERIFICATION',
              risk: DIDIT_RISK.POSSIBLE_DUPLICATED_USER,
              log_type: 'error',
              short_description: 'Possible duplicated approved user from other session',
              node_id: 'feature_ocr',
            },
          ],
        },
      ],
      liveness_checks: [
        {
          status: 'Declined',
          score: 97,
          warnings: [
            {
              feature: 'LIVENESS',
              risk: DIDIT_RISK.DUPLICATED_FACE,
              log_type: 'error',
              short_description: 'Duplicated face from other approved session',
              node_id: 'feature_liveness',
            },
          ],
        },
      ],
      ip_analyses: [
        {
          status: 'Approved',
          warnings: [
            {
              feature: 'LOCATION',
              risk: DIDIT_RISK.DUPLICATED_IP_ADDRESS,
              log_type: 'information',
              short_description: 'Duplicated IP address from another session',
              node_id: 'feature_ip_analysis',
            },
          ],
        },
      ],
    };

    const result = hydrateDecisionResponse(buildConfig(), raw);

    expect(result.warnings).toHaveLength(3);
    const features = result.warnings.map((w) => w.feature);
    expect(features).toContain('ID_VERIFICATION');
    expect(features).toContain('LIVENESS');
    expect(features).toContain('LOCATION');
  });

  it('derives failureReasonCode from highest-priority warning', () => {
    const raw: DecisionResponse = {
      session_id: FIXTURE_SESSION_ID,
      workflow_id: FIXTURE_KYC_WORKFLOW,
      vendor_data: FIXTURE_VENDOR_DATA,
      status: 'Declined',
      liveness_checks: [
        {
          status: 'Declined',
          score: 97,
          warnings: [
            {
              feature: 'LIVENESS',
              risk: DIDIT_RISK.DUPLICATED_FACE,
              log_type: 'error',
              short_description: 'Duplicated face from other approved session',
            },
            {
              feature: 'LIVENESS',
              risk: DIDIT_RISK.LOW_LIVENESS_SCORE,
              log_type: 'error',
              short_description: 'Liveness score below threshold',
            },
          ],
        },
      ],
    };

    const result = hydrateDecisionResponse(buildConfig(), raw);

    expect(result.failureReasonCode).toBe(DIDIT_RISK.DUPLICATED_FACE);
    expect(result.failureReasonText).toBe('Duplicated face from other approved session');
  });

  it('information-level warnings never become a failure reason', () => {
    const raw: DecisionResponse = {
      session_id: FIXTURE_SESSION_ID,
      workflow_id: FIXTURE_KYC_WORKFLOW,
      vendor_data: FIXTURE_VENDOR_DATA,
      status: 'Approved',
      ip_analyses: [
        {
          status: 'Approved',
          warnings: [
            {
              feature: 'LOCATION',
              risk: DIDIT_RISK.DUPLICATED_IP_ADDRESS,
              log_type: 'information',
              short_description: 'Duplicated IP address from another session',
            },
          ],
        },
      ],
    };

    const result = hydrateDecisionResponse(buildConfig(), raw);

    expect(result.failureReasonCode).toBeNull();
    expect(result.failureReasonText).toBeNull();
    // The warning is still surfaced (so the SOC can see it) but is
    // not promoted to a decline reason.
    expect(result.warnings).toHaveLength(1);
  });

  it('projects multiple ip_analyses captures (desktop + phone hand-off)', () => {
    const raw: DecisionResponse = {
      session_id: FIXTURE_SESSION_ID,
      workflow_id: FIXTURE_KYC_WORKFLOW,
      vendor_data: FIXTURE_VENDOR_DATA,
      status: 'Approved',
      ip_analyses: [
        {
          status: 'Approved',
          ip_address: '94.54.30.16',
          platform: 'mobile',
          os_family: 'Android',
          device_fingerprint: 'didit-fp-mobile',
          is_vpn_or_tor: false,
          is_data_center: false,
        },
        {
          status: 'Approved',
          ip_address: '94.54.30.16',
          platform: 'desktop',
          os_family: 'Windows',
          device_fingerprint: 'didit-fp-desktop',
          is_vpn_or_tor: false,
          is_data_center: false,
        },
      ],
    };

    const result = hydrateDecisionResponse(buildConfig(), raw);

    expect(result.ipAnalyses).toHaveLength(2);
    expect(result.ipAnalyses.map((c) => c.platform).sort()).toEqual(['desktop', 'mobile']);
    expect(result.ipAnalyses.every((c) => c.ipAddress === '94.54.30.16')).toBe(true);
  });
});

describe('hydrateDecisionResponse — Sprint 6 real-world declined fixture', () => {
  /**
   * Mirrors the production payload observed in the test session
   * `48017c03-f8ef-4bf9-ab34-1275dd8a10e5` where the user's face
   * matched session `a8baa82b...` and Didit declined with
   * `DUPLICATED_FACE` warning.
   *
   * Pins:
   *   - `liveness.passed: false` (from `status: 'Declined'`) is
   *     reported correctly even with score 97.73.
   *   - The actual decline reason `DUPLICATED_FACE` is now
   *     surfaced via `failureReasonCode` (the bug pre-Sprint-6
   *     was that this was lost, leaving only the misleading
   *     `passed: false` flag).
   */
  it('Sprint 6 declined-by-duplicate-face fixture surfaces DUPLICATED_FACE as decline reason', () => {
    const raw: DecisionResponse = {
      session_id: FIXTURE_SESSION_ID,
      workflow_id: FIXTURE_KYC_WORKFLOW,
      vendor_data: FIXTURE_VENDOR_DATA,
      status: 'Declined',
      id_verifications: [
        {
          status: 'Declined',
          document_type: 'Identity Card',
          document_number: 'A01M54100',
          first_name: 'Abdullah Faruk',
          last_name: 'Özden',
          date_of_birth: '1990-06-30',
          warnings: [
            {
              feature: 'ID_VERIFICATION',
              risk: DIDIT_RISK.POSSIBLE_DUPLICATED_USER,
              log_type: 'error',
              short_description: 'Possible duplicated approved user from other session',
              node_id: 'feature_ocr',
            },
          ],
          matches: [
            {
              session_id: FIXTURE_MATCHED_SESSION_ID,
              vendor_data: '{"customerId":"19b69f4d-df6b-40f9-becc-30f3bb00cbf1","type":"customer"}',
              status: 'Approved',
              is_blocklisted: false,
              session_number: 21,
            },
          ],
        },
      ],
      liveness_checks: [
        {
          status: 'Declined',
          score: 97.73,
          warnings: [
            {
              feature: 'LIVENESS',
              risk: DIDIT_RISK.DUPLICATED_FACE,
              log_type: 'error',
              short_description: 'Duplicated face from other approved session',
              node_id: 'feature_liveness',
            },
          ],
          matches: [
            {
              session_id: FIXTURE_MATCHED_SESSION_ID,
              vendor_data: '{"customerId":"19b69f4d-df6b-40f9-becc-30f3bb00cbf1","type":"customer"}',
              status: 'Approved',
              is_blocklisted: false,
              similarity_percentage: 86.04,
            },
          ],
        },
      ],
      face_matches: [{ status: 'Approved', score: 96.22 }],
      ip_analyses: [
        {
          status: 'Approved',
          ip_address: '94.54.30.16',
          ip_country_code: 'TR',
          platform: 'mobile',
          warnings: [
            {
              feature: 'LOCATION',
              risk: DIDIT_RISK.DUPLICATED_IP_ADDRESS,
              log_type: 'information',
              short_description: 'Duplicated IP address from another session',
            },
          ],
        },
      ],
    };

    const result = hydrateDecisionResponse(buildConfig(), raw);

    // Decline reason: the highest-priority warning.
    expect(result.failureReasonCode).toBe(DIDIT_RISK.DUPLICATED_FACE);
    expect(result.failureReasonText).toBe('Duplicated face from other approved session');

    // Both surfaces' matches are surfaced.
    expect(result.faceSearchMatches.length).toBe(2);

    // Per-block primary capture still works.
    expect(result.kyc?.documentNumber).toBe('A01M54100');
    expect(result.faceMatch?.passed).toBe(true); // 1:1 selfie-vs-ID still matched
    expect(result.liveness?.passed).toBe(false); // session-level cascade
    expect(result.liveness?.score).toBe(98); // Math.round(97.73)

    // IP analysis projected.
    expect(result.ipAnalyses[0]?.ipAddress).toBe('94.54.30.16');
  });
});
