/**
 * Tests for `lib/fraud/face-match.ts` — Sprint 6's central evaluator.
 *
 * Pins:
 *   - The 4-branch discriminated result (`no_match` / `reuse` /
 *     `block_toast` / `cascade_fraud`) is exhaustively reachable from
 *     the 10 documented scenarios.
 *   - Worst-case rule: ANY banned hit OR fraud-signal warning →
 *     cascade, regardless of how many other matches resolved clean.
 *   - Same-customer self re-verification (scenario 1) returns
 *     `no_match` — the user is just refreshing their own credential.
 *   - `block_toast` masks the matched email via `maskEmail` and that
 *     mask is the SAME deterministic shape every UI surface reads.
 *   - `pickToastTarget` prefers the most-recent clean customer match
 *     (scenario 10 worst-case rule, but applied to the toast target
 *     selection — not cascade triggering).
 *   - `parseMatchVendorData` rejects malformed JSON / missing fields
 *     / wrong type discriminant, so the lookup never feeds garbage
 *     to the evaluator.
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateFaceMatch,
  maskEmail,
  parseMatchVendorData,
  type FaceMatchContext,
  type FaceMatchLookup,
  type ResolvedMatch,
} from '@/lib/fraud/face-match';
import { DIDIT_RISK } from '@crivacy-fhe/adapter-didit/risk-codes';
import type {
  DiditDecisionPayload,
  DiditMatchEntry,
  DiditWarningEntry,
} from '@crivacy-fhe/adapter-didit/types';
import { asDiditSessionIdUnchecked } from '@crivacy-fhe/adapter-didit/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function match(overrides: Partial<DiditMatchEntry> = {}): DiditMatchEntry {
  return Object.freeze({
    source: 'liveness' as const,
    sessionId: 'matched-session-id',
    vendorData: null,
    verificationDate: null,
    status: 'Approved',
    isBlocklisted: false,
    similarityPercentage: 95,
    ...overrides,
  });
}

function warning(risk: string): DiditWarningEntry {
  return Object.freeze({
    feature: null,
    risk,
    logType: 'error' as const,
    shortDescription: `${risk}`,
    nodeId: null,
  });
}

function decision(overrides: {
  matches?: readonly DiditMatchEntry[];
  warnings?: readonly DiditWarningEntry[];
}): DiditDecisionPayload {
  return {
    sessionId: asDiditSessionIdUnchecked('current-session-id'),
    workflowId: '00000000-0000-0000-0000-000000000000' as never,
    workflowType: 'identity' as never,
    status: 'Approved' as never,
    vendorData: '{"crivacySessionId":"x","type":"customer","customerId":"x"}' as never,
    humanScore: 90,
    kyc: null,
    liveness: null,
    faceMatch: null,
    address: null,
    faceSearchMatches: overrides.matches ?? [],
    warnings: overrides.warnings ?? [],
    ipAnalyses: [],
    failureReasonCode: null,
    failureReasonText: null,
    createdAt: new Date('2026-05-09T00:00:00Z').toISOString(),
  };
}

function lookup(
  resolutions: readonly ResolvedMatch[],
): FaceMatchLookup {
  return {
    resolveMatches: async () => resolutions,
  };
}

const customerCtx: FaceMatchContext = { kind: 'customer', customerId: 'cust-current' };
const b2bCtx: FaceMatchContext = { kind: 'b2b', firmId: 'firm-A', userRef: 'user-1' };

// ---------------------------------------------------------------------------
// maskEmail — single source for toast text
// ---------------------------------------------------------------------------

describe('maskEmail', () => {
  it('produces a...d@***.com for a typical email', () => {
    expect(maskEmail('alice@example.com')).toBe('a...e@***.com');
    expect(maskEmail('bob@gmail.com')).toBe('b...b@***.com');
  });

  it('leaves single-char local-part unmasked (no privacy benefit)', () => {
    expect(maskEmail('a@example.com')).toBe('a@***.com');
  });

  it('leaves two-char local-part unmasked', () => {
    expect(maskEmail('ab@example.com')).toBe('ab@***.com');
  });

  it('returns fully-masked fallback for null / undefined / empty', () => {
    expect(maskEmail(null)).toBe('***@***.com');
    expect(maskEmail(undefined)).toBe('***@***.com');
    expect(maskEmail('')).toBe('***@***.com');
  });

  it('returns fully-masked fallback for malformed (no @)', () => {
    expect(maskEmail('notanemail')).toBe('***@***.com');
  });

  it('returns fully-masked fallback for @-prefixed string', () => {
    expect(maskEmail('@example.com')).toBe('***@***.com');
  });

  it('is deterministic across repeated calls (same input → same output)', () => {
    const out1 = maskEmail('alice@example.com');
    const out2 = maskEmail('alice@example.com');
    expect(out1).toBe(out2);
  });
});

// ---------------------------------------------------------------------------
// parseMatchVendorData — rejects garbage
// ---------------------------------------------------------------------------

describe('parseMatchVendorData', () => {
  it('parses customer vendor_data', () => {
    const raw = JSON.stringify({
      crivacySessionId: 'sess-1',
      type: 'customer',
      customerId: 'cust-1',
    });
    expect(parseMatchVendorData(raw)).toEqual({
      type: 'customer',
      customerId: 'cust-1',
      crivacySessionId: 'sess-1',
    });
  });

  it('parses b2b vendor_data', () => {
    const raw = JSON.stringify({
      crivacySessionId: 'sess-1',
      type: 'b2b',
      firmId: 'firm-1',
      userRef: 'user-1',
    });
    expect(parseMatchVendorData(raw)).toEqual({
      type: 'b2b',
      firmId: 'firm-1',
      userRef: 'user-1',
      crivacySessionId: 'sess-1',
    });
  });

  it('returns null for null input', () => {
    expect(parseMatchVendorData(null)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseMatchVendorData('not-json')).toBeNull();
    expect(parseMatchVendorData('{')).toBeNull();
  });

  it('returns null for non-object JSON (string, array, number)', () => {
    expect(parseMatchVendorData('"a-string"')).toBeNull();
    expect(parseMatchVendorData('[1,2,3]')).toBeNull();
    expect(parseMatchVendorData('42')).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(
      parseMatchVendorData(
        JSON.stringify({ crivacySessionId: 'x', type: 'admin', adminId: 'y' }),
      ),
    ).toBeNull();
  });

  it('returns null when crivacySessionId is missing', () => {
    expect(
      parseMatchVendorData(JSON.stringify({ type: 'customer', customerId: 'x' })),
    ).toBeNull();
  });

  it('returns null when customer.customerId is empty', () => {
    expect(
      parseMatchVendorData(
        JSON.stringify({ crivacySessionId: 'x', type: 'customer', customerId: '' }),
      ),
    ).toBeNull();
  });

  it('returns null when b2b firmId or userRef is missing', () => {
    expect(
      parseMatchVendorData(
        JSON.stringify({ crivacySessionId: 'x', type: 'b2b', firmId: 'f' }),
      ),
    ).toBeNull();
    expect(
      parseMatchVendorData(
        JSON.stringify({ crivacySessionId: 'x', type: 'b2b', userRef: 'u' }),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateFaceMatch — branch coverage
// ---------------------------------------------------------------------------

describe('evaluateFaceMatch — no_match branch', () => {
  it('returns no_match when there are no faceSearchMatches and no warnings', async () => {
    const result = await evaluateFaceMatch(
      { lookup: lookup([]) },
      decision({ matches: [], warnings: [] }),
      customerCtx,
    );
    expect(result.kind).toBe('no_match');
  });

  it('returns no_match for scenario 1 — same customer self re-verification', async () => {
    const m = match({ vendorData: 'json' });
    const result = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m,
            status: { kind: 'customer_clean', customerId: 'cust-current', email: 'self@x.com' },
          },
        ]),
      },
      decision({ matches: [m] }),
      customerCtx,
    );
    expect(result.kind).toBe('no_match');
  });

  it('returns no_match when all matches are unparseable / unknown', async () => {
    const m = match();
    const result = await evaluateFaceMatch(
      { lookup: lookup([{ match: m, status: { kind: 'unknown' } }]) },
      decision({ matches: [m] }),
      customerCtx,
    );
    expect(result.kind).toBe('no_match');
  });
});

describe('evaluateFaceMatch — block_toast branch', () => {
  it('returns block_toast for scenario 2 — different clean customer', async () => {
    const m = match();
    const result = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m,
            status: {
              kind: 'customer_clean',
              customerId: 'cust-other',
              email: 'other@example.com',
            },
          },
        ]),
      },
      decision({ matches: [m] }),
      customerCtx,
    );
    expect(result.kind).toBe('block_toast');
    if (result.kind === 'block_toast') {
      expect(result.maskedEmail).toBe('o...r@***.com');
      expect(result.resolvedMatch.match).toBe(m);
    }
  });

  it('picks the most-recent clean customer for the toast target', async () => {
    const matchOlder = match({ sessionId: 'older', verificationDate: '2026-01-01T00:00:00Z' });
    const matchNewer = match({ sessionId: 'newer', verificationDate: '2026-04-01T00:00:00Z' });
    const result = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: matchOlder,
            status: { kind: 'customer_clean', customerId: 'cust-x', email: 'older@x.com' },
          },
          {
            match: matchNewer,
            status: { kind: 'customer_clean', customerId: 'cust-y', email: 'newer@y.com' },
          },
        ]),
      },
      decision({ matches: [matchOlder, matchNewer] }),
      customerCtx,
    );
    expect(result.kind).toBe('block_toast');
    if (result.kind === 'block_toast') {
      expect(result.resolvedMatch.match.sessionId).toBe('newer');
      expect(result.maskedEmail).toBe('n...r@***.com');
    }
  });

  it('produces fully-masked toast when matched customer has no email (wallet-only)', async () => {
    const m = match();
    const result = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m,
            status: { kind: 'customer_clean', customerId: 'cust-wallet', email: null },
          },
        ]),
      },
      decision({ matches: [m] }),
      customerCtx,
    );
    expect(result.kind).toBe('block_toast');
    if (result.kind === 'block_toast') {
      expect(result.maskedEmail).toBe('***@***.com');
    }
  });
});

describe('evaluateFaceMatch — reuse branch', () => {
  it('returns reuse for scenario 3 — B2B-only match (no clean customer)', async () => {
    const m = match();
    const result = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m,
            status: { kind: 'b2b_only', firmId: 'firm-A', userRef: 'user-1' },
          },
        ]),
      },
      decision({ matches: [m] }),
      b2bCtx,
    );
    expect(result.kind).toBe('reuse');
    if (result.kind === 'reuse') {
      expect(result.resolvedMatch.status).toEqual({
        kind: 'b2b_only',
        firmId: 'firm-A',
        userRef: 'user-1',
      });
    }
  });

  it('returns reuse for scenario 4 — customer self-signup matches a B2B userRef', async () => {
    const m = match();
    const result = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m,
            status: { kind: 'b2b_only', firmId: 'firm-X', userRef: 'user-99' },
          },
        ]),
      },
      decision({ matches: [m] }),
      customerCtx,
    );
    expect(result.kind).toBe('reuse');
  });
});

describe('evaluateFaceMatch — cascade_fraud branch', () => {
  it('returns cascade_fraud for scenario 5 — banned customer match', async () => {
    const m = match();
    const result = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m,
            status: { kind: 'customer_banned', customerId: 'cust-banned', email: 'b@x.com' },
          },
        ]),
      },
      decision({ matches: [m] }),
      customerCtx,
    );
    expect(result.kind).toBe('cascade_fraud');
    if (result.kind === 'cascade_fraud') {
      expect(result.reasonCode).toBe('matched_banned_account');
    }
  });

  it('returns cascade_fraud for scenario 6 — Didit fraud signal (LIVENESS_FACE_ATTACK)', async () => {
    const result = await evaluateFaceMatch(
      { lookup: lookup([]) },
      decision({
        matches: [],
        warnings: [warning(DIDIT_RISK.LIVENESS_FACE_ATTACK)],
      }),
      customerCtx,
    );
    expect(result.kind).toBe('cascade_fraud');
    if (result.kind === 'cascade_fraud') {
      expect(result.reasonCode).toBe(DIDIT_RISK.LIVENESS_FACE_ATTACK);
    }
  });

  it('returns cascade_fraud for FACE_IN_BLOCKLIST signal', async () => {
    const result = await evaluateFaceMatch(
      { lookup: lookup([]) },
      decision({
        matches: [],
        warnings: [warning(DIDIT_RISK.FACE_IN_BLOCKLIST)],
      }),
      customerCtx,
    );
    expect(result.kind).toBe('cascade_fraud');
  });

  it('worst-case rule — ANY banned hit cascades, even with clean matches alongside', async () => {
    const m1 = match({ sessionId: 'm1' });
    const m2 = match({ sessionId: 'm2' });
    const result = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m1,
            status: { kind: 'customer_clean', customerId: 'cust-clean', email: 'a@a.com' },
          },
          {
            match: m2,
            status: { kind: 'customer_banned', customerId: 'cust-banned', email: 'b@b.com' },
          },
        ]),
      },
      decision({ matches: [m1, m2] }),
      customerCtx,
    );
    expect(result.kind).toBe('cascade_fraud');
  });

  it('fraud signals win over banned matches (priority: signal first, but both cascade)', async () => {
    // When both fire, reasonCode comes from the fraud signal (more specific).
    const m = match();
    const result = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m,
            status: { kind: 'customer_banned', customerId: 'cust-b', email: 'b@b.com' },
          },
        ]),
      },
      decision({
        matches: [m],
        warnings: [warning(DIDIT_RISK.PORTRAIT_MANIPULATION_DETECTED)],
      }),
      customerCtx,
    );
    expect(result.kind).toBe('cascade_fraud');
    if (result.kind === 'cascade_fraud') {
      // Fraud signal wins (matched-banned would have been a fallback)
      expect(result.reasonCode).toBe(DIDIT_RISK.PORTRAIT_MANIPULATION_DETECTED);
    }
  });

  it('does NOT cascade on duplicate-detection codes alone (DUPLICATED_FACE without banned hit)', async () => {
    // DUPLICATED_FACE is a duplicate-detection signal, not a fraud
    // signal. Cascade depends on the matched account's status. With
    // a clean match, the result is block_toast — not cascade.
    const m = match();
    const result = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m,
            status: { kind: 'customer_clean', customerId: 'cust-other', email: 'o@o.com' },
          },
        ]),
      },
      decision({
        matches: [m],
        warnings: [warning(DIDIT_RISK.DUPLICATED_FACE)],
      }),
      customerCtx,
    );
    expect(result.kind).toBe('block_toast');
  });
});

describe('evaluateFaceMatch — order independence', () => {
  it('worst-case rule applies regardless of match order', async () => {
    const m1 = match({ sessionId: 'm1' });
    const m2 = match({ sessionId: 'm2' });

    const orderA = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m1,
            status: { kind: 'customer_banned', customerId: 'cust-b', email: null },
          },
          {
            match: m2,
            status: { kind: 'customer_clean', customerId: 'cust-c', email: 'c@c.com' },
          },
        ]),
      },
      decision({ matches: [m1, m2] }),
      customerCtx,
    );

    const orderB = await evaluateFaceMatch(
      {
        lookup: lookup([
          {
            match: m2,
            status: { kind: 'customer_clean', customerId: 'cust-c', email: 'c@c.com' },
          },
          {
            match: m1,
            status: { kind: 'customer_banned', customerId: 'cust-b', email: null },
          },
        ]),
      },
      decision({ matches: [m2, m1] }),
      customerCtx,
    );

    expect(orderA.kind).toBe('cascade_fraud');
    expect(orderB.kind).toBe('cascade_fraud');
  });
});
