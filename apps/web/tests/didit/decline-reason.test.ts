/**
 * Tests for `lib/didit/decline-reason.ts` — priority-rank resolution
 * over a flat `DiditWarningEntry[]` list. Pins the contract that:
 *
 *   - Higher-priority codes WIN over lower-priority codes when both
 *     fire on the same session (the table-stakes case for a real
 *     declined session that emits multiple warnings).
 *   - Information-level warnings (e.g. `DUPLICATED_IP_ADDRESS`) are
 *     ignored entirely — never surface as decline reasons.
 *   - Empty / non-actionable lists return `(null, null)` — caller
 *     falls back to a generic message.
 *   - Unknown codes (Didit ships new ones between versions) are
 *     ranked LAST so they never outrank a known code. If ONLY
 *     unknowns fired, the first one is surfaced as a tail-fallback
 *     so the operator has SOMETHING to grep.
 */

import { describe, expect, it } from 'vitest';

import { resolveDeclineReason } from '@crivacy-fhe/adapter-didit/decline-reason';
import { DIDIT_RISK } from '@crivacy-fhe/adapter-didit/risk-codes';
import type { DiditWarningEntry } from '@crivacy-fhe/adapter-didit/types';

function warning(
  risk: string,
  overrides: Partial<DiditWarningEntry> = {},
): DiditWarningEntry {
  return Object.freeze({
    feature: null,
    risk,
    logType: 'error',
    shortDescription: `${risk} description`,
    nodeId: null,
    ...overrides,
  });
}

describe('resolveDeclineReason — empty list', () => {
  it('returns (null, null) when no warnings fired', () => {
    expect(resolveDeclineReason([])).toEqual({ code: null, text: null });
  });

  it('returns (null, null) when only information-level entries fired', () => {
    const result = resolveDeclineReason([
      warning(DIDIT_RISK.DUPLICATED_IP_ADDRESS, { logType: 'information' }),
    ]);
    expect(result).toEqual({ code: null, text: null });
  });
});

describe('resolveDeclineReason — priority order', () => {
  it('DUPLICATED_FACE outranks LOW_LIVENESS_SCORE', () => {
    const result = resolveDeclineReason([
      warning(DIDIT_RISK.LOW_LIVENESS_SCORE),
      warning(DIDIT_RISK.DUPLICATED_FACE),
    ]);
    expect(result.code).toBe(DIDIT_RISK.DUPLICATED_FACE);
    expect(result.text).toBe('DUPLICATED_FACE description');
  });

  it('LIVENESS_FACE_ATTACK outranks DOCUMENT_EXPIRED', () => {
    const result = resolveDeclineReason([
      warning(DIDIT_RISK.DOCUMENT_EXPIRED),
      warning(DIDIT_RISK.LIVENESS_FACE_ATTACK),
    ]);
    expect(result.code).toBe(DIDIT_RISK.LIVENESS_FACE_ATTACK);
  });

  it('biometric duplicate outranks document duplicate', () => {
    const result = resolveDeclineReason([
      warning(DIDIT_RISK.POSSIBLE_DUPLICATED_USER),
      warning(DIDIT_RISK.DUPLICATED_FACE),
    ]);
    expect(result.code).toBe(DIDIT_RISK.DUPLICATED_FACE);
  });

  it('DUPLICATED_FACE outranks POSSIBLE_DUPLICATED_FACE', () => {
    const result = resolveDeclineReason([
      warning(DIDIT_RISK.POSSIBLE_DUPLICATED_FACE),
      warning(DIDIT_RISK.DUPLICATED_FACE),
    ]);
    expect(result.code).toBe(DIDIT_RISK.DUPLICATED_FACE);
  });

  it('priority order is stable regardless of input order', () => {
    const codes = [
      DIDIT_RISK.NO_FACE_DETECTED,
      DIDIT_RISK.DUPLICATED_FACE,
      DIDIT_RISK.LOW_FACE_QUALITY,
      DIDIT_RISK.LIVENESS_FACE_ATTACK,
    ].map((c) => warning(c));

    const fwd = resolveDeclineReason(codes);
    const rev = resolveDeclineReason([...codes].reverse());
    expect(fwd.code).toBe(rev.code);
    // Among these, DUPLICATED_FACE is highest (priority 1).
    expect(fwd.code).toBe(DIDIT_RISK.DUPLICATED_FACE);
  });
});

describe('resolveDeclineReason — unknown codes', () => {
  it('unknown code never outranks a known code', () => {
    const result = resolveDeclineReason([
      warning('SOMETHING_NEW_DIDIT_SHIPPED'),
      warning(DIDIT_RISK.LOW_LIVENESS_SCORE),
    ]);
    expect(result.code).toBe(DIDIT_RISK.LOW_LIVENESS_SCORE);
  });

  it('returns the first unknown when only unknowns fire', () => {
    const result = resolveDeclineReason([
      warning('FIRST_UNKNOWN'),
      warning('SECOND_UNKNOWN'),
    ]);
    expect(result.code).toBe('FIRST_UNKNOWN');
  });

  it('information-level unknowns are still ignored', () => {
    const result = resolveDeclineReason([
      warning('NEW_INFO_CODE', { logType: 'information' }),
    ]);
    expect(result).toEqual({ code: null, text: null });
  });
});

describe('resolveDeclineReason — text propagation', () => {
  it('returns the short_description of the winning warning', () => {
    const result = resolveDeclineReason([
      warning(DIDIT_RISK.DUPLICATED_FACE, {
        shortDescription: 'Duplicated face from another approved session',
      }),
      warning(DIDIT_RISK.LOW_LIVENESS_SCORE, {
        shortDescription: 'Liveness score below threshold',
      }),
    ]);
    expect(result.text).toBe('Duplicated face from another approved session');
  });

  it('text is null when winning warning has no description', () => {
    const result = resolveDeclineReason([
      warning(DIDIT_RISK.DUPLICATED_FACE, { shortDescription: null }),
    ]);
    expect(result.text).toBeNull();
  });
});

describe('resolveDeclineReason — Sprint 6 cascade scenarios', () => {
  it('real-world: DUPLICATED_FACE on liveness + DUPLICATED_IP_ADDRESS info → DUPLICATED_FACE', () => {
    // Mirrors the raw Didit payload observed in the Sprint 6 test
    // (farukest5 face_search hit + same-IP signal).
    const result = resolveDeclineReason([
      warning(DIDIT_RISK.DUPLICATED_FACE, {
        feature: 'LIVENESS',
        shortDescription: 'Duplicated face from other approved session',
      }),
      warning(DIDIT_RISK.POSSIBLE_DUPLICATED_USER, {
        feature: 'ID_VERIFICATION',
        shortDescription: 'Possible duplicated approved user from other session',
      }),
      warning(DIDIT_RISK.DUPLICATED_IP_ADDRESS, {
        feature: 'LOCATION',
        logType: 'information',
        shortDescription: 'Duplicated IP address from another session',
      }),
    ]);
    expect(result.code).toBe(DIDIT_RISK.DUPLICATED_FACE);
    expect(result.text).toBe('Duplicated face from other approved session');
  });

  it('document duplicate (POSSIBLE_DUPLICATED_USER) outranks portrait spoof', () => {
    // POSSIBLE_DUPLICATED_USER is in the document-duplicate tier
    // (priority 2 — sits just below biometric duplicate). Spoof
    // signals like PORTRAIT_MANIPULATION_DETECTED are in tier 3.
    // Lower index in DIDIT_DECLINE_REASON_PRIORITY = higher priority.
    const result = resolveDeclineReason([
      warning(DIDIT_RISK.PORTRAIT_MANIPULATION_DETECTED),
      warning(DIDIT_RISK.POSSIBLE_DUPLICATED_USER),
    ]);
    expect(result.code).toBe(DIDIT_RISK.POSSIBLE_DUPLICATED_USER);
  });

  it('blocklist hit outranks document quality issue', () => {
    const result = resolveDeclineReason([
      warning(DIDIT_RISK.LOW_FACE_QUALITY),
      warning(DIDIT_RISK.FACE_IN_BLOCKLIST),
    ]);
    expect(result.code).toBe(DIDIT_RISK.FACE_IN_BLOCKLIST);
  });
});
