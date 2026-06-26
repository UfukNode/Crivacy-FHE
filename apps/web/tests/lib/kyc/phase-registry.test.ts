/**
 * Tests for `lib/kyc/phase-registry.ts` — the Sprint 9 single source
 * of truth for every KYC phase. The registry feeds:
 *
 *   * `/api/customer/kyc/start-identity` and `/start-address` handlers
 *     (eligibility),
 *   * `/api/customer/kyc/start-from-consent` (OAuth fast-path
 *     entry-point picker),
 *   * `/kyc` step page (status + description rendering),
 *   * `/api/customer/kyc/callback-status` (variant resolver),
 *   * `/kyc/callback` page (renders the registry-resolved variant).
 *
 * Drift between any of those surfaces is a regression. These tests
 * pin the contract.
 */

import { describe, expect, it } from 'vitest';

import {
  ADDRESS_PHASE,
  CUSTOMER_KYC_LEVELS,
  IDENTITY_PHASE,
  KYC_PHASES,
  NFT_MINT_PHASE,
  type CustomerKycLevel,
  type PhaseStateInput,
  findPhaseByDiditWorkflow,
  getPhase,
  isCustomerKycLevel,
  nextDiditPhase,
  rankCustomerKycLevel,
} from '@/lib/kyc/phase-registry';
import type { KycStatus } from '@crivacy/shared-types';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function state(
  overrides: Partial<PhaseStateInput> & { customerKycLevel: CustomerKycLevel },
): PhaseStateInput {
  return {
    hasActiveSession: false,
    inReview: false,
    sessionInFlight: false,
    nftContractId: null,
    mintProgress: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Level utilities                                                   */
/* ------------------------------------------------------------------ */

describe('CUSTOMER_KYC_LEVELS — canonical ordered list', () => {
  it('matches the customer_kyc_level Postgres enum order', () => {
    expect(CUSTOMER_KYC_LEVELS).toEqual(['kyc_0', 'kyc_1', 'kyc_2', 'kyc_3', 'kyc_4']);
  });

  it('frozen — no callers can mutate the SoT', () => {
    expect(Object.isFrozen(CUSTOMER_KYC_LEVELS)).toBe(true);
  });
});

describe('rankCustomerKycLevel', () => {
  it('returns ordered ranks', () => {
    expect(rankCustomerKycLevel('kyc_0')).toBe(0);
    expect(rankCustomerKycLevel('kyc_1')).toBe(1);
    expect(rankCustomerKycLevel('kyc_2')).toBe(2);
    expect(rankCustomerKycLevel('kyc_3')).toBe(3);
    expect(rankCustomerKycLevel('kyc_4')).toBe(4);
  });
});

describe('isCustomerKycLevel — string narrowing guard', () => {
  it.each(CUSTOMER_KYC_LEVELS)('accepts %s', (level) => {
    expect(isCustomerKycLevel(level)).toBe(true);
  });

  it.each([
    '',
    'kyc',
    'kyc_5',
    'KYC_3',
    'kyc_3 ',
    ' kyc_3',
    '<script>',
  ])('rejects %p', (value) => {
    expect(isCustomerKycLevel(value)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Phase registry shape                                              */
/* ------------------------------------------------------------------ */

describe('KYC_PHASES — registry shape', () => {
  it('contains identity, address, nft_mint in stepper order', () => {
    expect(KYC_PHASES.map((p) => p.id)).toEqual(['identity', 'address', 'nft_mint']);
  });

  it('every phase exposes the contract fields', () => {
    for (const phase of KYC_PHASES) {
      expect(typeof phase.id).toBe('string');
      expect(typeof phase.stepLabel).toBe('string');
      expect(typeof phase.opensAtLevel).toBe('string');
      expect(Array.isArray(phase.eligibleStartLevels)).toBe(true);
      expect(typeof phase.supportsHandoff).toBe('boolean');
      expect(typeof phase.supportsForwardDriftReconciliation).toBe('boolean');
      expect(typeof phase.supportsReverseDriftReconciliation).toBe('boolean');
      expect(typeof phase.describe).toBe('function');
      expect(typeof phase.resolveStepStatus).toBe('function');
    }
  });

  it('only didit-driven phases carry a workflow + endpoint', () => {
    expect(IDENTITY_PHASE.diditWorkflow).toBe('identity');
    expect(IDENTITY_PHASE.startEndpoint).toBe('/api/customer/kyc/start-identity');
    expect(ADDRESS_PHASE.diditWorkflow).toBe('address');
    expect(ADDRESS_PHASE.startEndpoint).toBe('/api/customer/kyc/start-address');
    expect(NFT_MINT_PHASE.diditWorkflow).toBeNull();
    expect(NFT_MINT_PHASE.startEndpoint).toBeNull();
  });

  it('only didit-driven phases participate in drift reconciliation', () => {
    expect(IDENTITY_PHASE.supportsForwardDriftReconciliation).toBe(true);
    expect(ADDRESS_PHASE.supportsForwardDriftReconciliation).toBe(true);
    expect(NFT_MINT_PHASE.supportsForwardDriftReconciliation).toBe(false);
  });

  // Sprint 10: pin handoff support per phase. Identity + address both
  // surface the QR sub-section through the unified `KycActionPanel`;
  // mint has no hosted Didit flow at all so it never offers handoff.
  // Pre-Sprint-10 ADDRESS_PHASE was `false`, which meant the address
  // step page on /kyc rendered a plain Button bypassing the cross-
  // device flow entirely — a regression caught during the live test.
  it('handoff support: identity + address true, mint false', () => {
    expect(IDENTITY_PHASE.supportsHandoff).toBe(true);
    expect(ADDRESS_PHASE.supportsHandoff).toBe(true);
    expect(NFT_MINT_PHASE.supportsHandoff).toBe(false);
  });

  // Sprint 10 (5th-attempt fix): pin handoff DEFAULT per phase. The
  // panel reads `defaultsToHandoff` to decide whether to redirect the
  // desktop tab to Didit on click (identity, when camera is granted)
  // or to open the QR sub-section inline (address, always).
  // Regressing this flips address back to a desktop-redirect UX —
  // exactly the bug the live test caught and burned $1.00 over.
  it('handoff default: address opens QR inline, identity defers to camera check', () => {
    expect(IDENTITY_PHASE.defaultsToHandoff).toBe(false);
    expect(ADDRESS_PHASE.defaultsToHandoff).toBe(true);
    expect(NFT_MINT_PHASE.defaultsToHandoff).toBe(false);
  });
});

describe('getPhase / findPhaseByDiditWorkflow', () => {
  it('getPhase returns the same identity-equal entry', () => {
    expect(getPhase('identity')).toBe(IDENTITY_PHASE);
    expect(getPhase('address')).toBe(ADDRESS_PHASE);
    expect(getPhase('nft_mint')).toBe(NFT_MINT_PHASE);
  });

  it('findPhaseByDiditWorkflow maps "identity"/"address" → registry entry', () => {
    expect(findPhaseByDiditWorkflow('identity')).toBe(IDENTITY_PHASE);
    expect(findPhaseByDiditWorkflow('address')).toBe(ADDRESS_PHASE);
  });

  it('findPhaseByDiditWorkflow returns null for unknown / null', () => {
    expect(findPhaseByDiditWorkflow(null)).toBeNull();
    expect(findPhaseByDiditWorkflow('nft_mint')).toBeNull();
    expect(findPhaseByDiditWorkflow('unknown_workflow')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Eligibility                                                       */
/* ------------------------------------------------------------------ */

describe('IDENTITY_PHASE.eligibleStartLevels', () => {
  it('accepts kyc_0 and kyc_1 only — kyc_2 is in-review (Didit-owned)', () => {
    expect(IDENTITY_PHASE.eligibleStartLevels).toEqual(['kyc_0', 'kyc_1']);
  });
});

describe('ADDRESS_PHASE.eligibleStartLevels', () => {
  it('accepts kyc_3 only — pre-kyc_3 = identity not done, kyc_4 = already complete', () => {
    expect(ADDRESS_PHASE.eligibleStartLevels).toEqual(['kyc_3']);
  });
});

describe('NFT_MINT_PHASE.eligibleStartLevels', () => {
  it('is empty — mint is not opened by a kyc/start-* handler', () => {
    expect(NFT_MINT_PHASE.eligibleStartLevels).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Step status                                                       */
/* ------------------------------------------------------------------ */

describe('IDENTITY_PHASE.resolveStepStatus', () => {
  it.each<readonly [CustomerKycLevel, 'active' | 'in_review' | 'completed']>([
    ['kyc_0', 'active'],
    ['kyc_1', 'active'],
    ['kyc_2', 'in_review'],
    ['kyc_3', 'completed'],
    ['kyc_4', 'completed'],
  ])('%s without inReview flag → %s', (level, expected) => {
    expect(IDENTITY_PHASE.resolveStepStatus(state({ customerKycLevel: level }))).toBe(expected);
  });

  it('inReview flag flips kyc_0 / kyc_1 to in_review', () => {
    expect(
      IDENTITY_PHASE.resolveStepStatus(state({ customerKycLevel: 'kyc_0', inReview: true })),
    ).toBe('in_review');
    expect(
      IDENTITY_PHASE.resolveStepStatus(state({ customerKycLevel: 'kyc_1', inReview: true })),
    ).toBe('in_review');
  });

  it('inReview flag does not regress completed states', () => {
    expect(
      IDENTITY_PHASE.resolveStepStatus(state({ customerKycLevel: 'kyc_3', inReview: true })),
    ).toBe('completed');
    expect(
      IDENTITY_PHASE.resolveStepStatus(state({ customerKycLevel: 'kyc_4', inReview: true })),
    ).toBe('completed');
  });
});

describe('ADDRESS_PHASE.resolveStepStatus', () => {
  it.each<readonly [CustomerKycLevel, 'locked' | 'active' | 'completed']>([
    ['kyc_0', 'locked'],
    ['kyc_1', 'locked'],
    ['kyc_2', 'locked'],
    ['kyc_3', 'active'],
    ['kyc_4', 'completed'],
  ])('%s without inReview → %s', (level, expected) => {
    expect(ADDRESS_PHASE.resolveStepStatus(state({ customerKycLevel: level }))).toBe(expected);
  });

  it('inReview flag flips kyc_3 to in_review', () => {
    expect(
      ADDRESS_PHASE.resolveStepStatus(state({ customerKycLevel: 'kyc_3', inReview: true })),
    ).toBe('in_review');
  });

  it('inReview flag does not regress completed (kyc_4)', () => {
    expect(
      ADDRESS_PHASE.resolveStepStatus(state({ customerKycLevel: 'kyc_4', inReview: true })),
    ).toBe('completed');
  });

  it('inReview flag does not unlock pre-kyc_3 levels', () => {
    expect(
      ADDRESS_PHASE.resolveStepStatus(state({ customerKycLevel: 'kyc_2', inReview: true })),
    ).toBe('in_review');
    // ^ Address resolver returns in_review even when locked because
    // the inReview flag wins. This is intentional — if a session is
    // marked in-review at the lower level, the UI surfaces that
    // hint rather than masking it as "locked".
  });
});

describe('NFT_MINT_PHASE.resolveStepStatus', () => {
  it('locked below kyc_4', () => {
    for (const level of ['kyc_0', 'kyc_1', 'kyc_2', 'kyc_3'] as const) {
      expect(NFT_MINT_PHASE.resolveStepStatus(state({ customerKycLevel: level }))).toBe('locked');
    }
  });

  it('active at kyc_4 with no contract id', () => {
    expect(NFT_MINT_PHASE.resolveStepStatus(state({ customerKycLevel: 'kyc_4' }))).toBe('active');
  });

  it('completed at kyc_4 with contract id', () => {
    expect(
      NFT_MINT_PHASE.resolveStepStatus(
        state({ customerKycLevel: 'kyc_4', nftContractId: '00:abc' }),
      ),
    ).toBe('completed');
  });
});

/* ------------------------------------------------------------------ */
/*  Sub-steps                                                         */
/* ------------------------------------------------------------------ */

describe('IDENTITY_PHASE.subSteps', () => {
  it('returns 2 steps tracking document + liveness', () => {
    const steps = IDENTITY_PHASE.subSteps?.(state({ customerKycLevel: 'kyc_0' })) ?? [];
    expect(steps.length).toBe(2);
    expect(steps[0]?.label).toMatch(/document/i);
    expect(steps[1]?.label).toMatch(/liveness/i);
  });

  it.each<[CustomerKycLevel, 'pending' | 'completed', 'pending' | 'completed']>([
    ['kyc_0', 'pending', 'pending'],
    ['kyc_1', 'pending', 'pending'],
    // Didit returns the identity decision (document + liveness) atomically,
    // so the two rows flip together — we never claim one passed before the
    // other. Both stay pending until identity is approved (kyc_3).
    ['kyc_2', 'pending', 'pending'],
    ['kyc_3', 'completed', 'completed'],
    ['kyc_4', 'completed', 'completed'],
  ])('%s → doc=%s, liveness=%s', (level, expectedDoc, expectedLiveness) => {
    const steps = IDENTITY_PHASE.subSteps?.(state({ customerKycLevel: level })) ?? [];
    expect(steps[0]?.status).toBe(expectedDoc);
    expect(steps[1]?.status).toBe(expectedLiveness);
  });

  // The stepper's `in_progress` (animated theme-accent) visual must
  // light up when a Didit session is in flight on a device. Pre-fix
  // both rows fell through to grey `pending` while a phone was
  // mid-capture — making it look like nothing was happening.
  it('flips not-yet-completed rows to in_progress when sessionInFlight=true', () => {
    const steps =
      IDENTITY_PHASE.subSteps?.(
        state({ customerKycLevel: 'kyc_0', sessionInFlight: true }),
      ) ?? [];
    expect(steps[0]?.status).toBe('in_progress');
    expect(steps[1]?.status).toBe('in_progress');
  });

  it('flips both identity rows to in_progress when sessionInFlight=true at kyc_2', () => {
    // kyc_2 = identity decision still in flight. Document + liveness resolve
    // together (Didit returns them atomically), so both rows animate as
    // `in_progress` during capture rather than faking a completed document.
    const steps =
      IDENTITY_PHASE.subSteps?.(
        state({ customerKycLevel: 'kyc_2', sessionInFlight: true }),
      ) ?? [];
    expect(steps[0]?.status).toBe('in_progress');
    expect(steps[1]?.status).toBe('in_progress');
  });
});

describe('ADDRESS_PHASE.subSteps / NFT_MINT_PHASE.subSteps', () => {
  it('address has no sub-steps outside the mint window', () => {
    // Address phase only emits sub-steps when there is a credential
    // mint to track (i.e. in the gap between Didit-approved decision
    // and Chain commit). Outside that window the parent description
    // carries the full message.
    const subs = ADDRESS_PHASE.subSteps?.(state({ customerKycLevel: 'kyc_3' })) ?? [];
    expect(subs).toEqual([]);
  });

  it('address renders an in_progress capture row when sessionInFlight=true (no mint yet)', () => {
    // While a customer is mid-capture on the address phase (phone
    // uploading the utility bill / bank statement) the stepper must
    // show active work, not the silent empty state. The single
    // `in_progress` row mirrors identity's two in-flight rows.
    const subs =
      ADDRESS_PHASE.subSteps?.(
        state({ customerKycLevel: 'kyc_3', sessionInFlight: true }),
      ) ?? [];
    expect(subs.length).toBe(1);
    expect(subs[0]?.status).toBe('in_progress');
  });

  it('address renders verified + issuing sub-steps inside the mint window', () => {
    const subs =
      ADDRESS_PHASE.subSteps?.(
        state({
          customerKycLevel: 'kyc_3',
          mintProgress: { state: 'pending', attempts: 1, totalAttempts: 6 },
        }),
      ) ?? [];
    expect(subs.map((s) => s.status)).toEqual(['completed', 'in_progress']);
  });

  it('mint has no sub-steps', () => {
    expect(NFT_MINT_PHASE.subSteps).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Callback variant resolution — the Sprint 9 trust boundary         */
/* ------------------------------------------------------------------ */

const TERMINAL_APPROVED: KycStatus = 'approved';
const TERMINAL_DECLINED: readonly KycStatus[] = ['rejected', 'expired', 'revoked', 'kyc_expired'];
const IN_PROGRESS: readonly KycStatus[] = [
  'pending',
  'in_progress',
  'address_in_progress',
  'resubmission_pending',
];

describe('IDENTITY_PHASE.resolveCallbackVariant', () => {
  it('null → unknown', () => {
    expect(IDENTITY_PHASE.resolveCallbackVariant?.(null)).toBe('unknown');
  });

  it('approved → approved', () => {
    expect(IDENTITY_PHASE.resolveCallbackVariant?.(TERMINAL_APPROVED)).toBe('approved');
  });

  it('identity_approved → approved (terminal identity success)', () => {
    expect(IDENTITY_PHASE.resolveCallbackVariant?.('identity_approved')).toBe('approved');
  });

  it('in_review → in_review', () => {
    expect(IDENTITY_PHASE.resolveCallbackVariant?.('in_review')).toBe('in_review');
  });

  it.each(TERMINAL_DECLINED)('terminal-decline status %s → declined', (status) => {
    expect(IDENTITY_PHASE.resolveCallbackVariant?.(status)).toBe('declined');
  });

  it.each(IN_PROGRESS)('in-flight status %s → in_progress', (status) => {
    expect(IDENTITY_PHASE.resolveCallbackVariant?.(status)).toBe('in_progress');
  });
});

describe('ADDRESS_PHASE.resolveCallbackVariant', () => {
  it('matches IDENTITY for every KycStatus — same Didit-driven mapping', () => {
    const allStatuses: readonly KycStatus[] = [
      'approved',
      'in_review',
      ...TERMINAL_DECLINED,
      ...IN_PROGRESS,
    ];
    for (const s of allStatuses) {
      expect(ADDRESS_PHASE.resolveCallbackVariant?.(s)).toBe(
        IDENTITY_PHASE.resolveCallbackVariant?.(s),
      );
    }
  });
});

describe('NFT_MINT_PHASE.resolveCallbackVariant', () => {
  it('is null — mint never redirects through /kyc/callback', () => {
    expect(NFT_MINT_PHASE.resolveCallbackVariant).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Entry-point selection (OAuth fast path)                            */
/* ------------------------------------------------------------------ */

describe('nextDiditPhase', () => {
  it('kyc_0 / kyc_1 / kyc_2 → identity', () => {
    expect(nextDiditPhase('kyc_0')?.id).toBe('identity');
    expect(nextDiditPhase('kyc_1')?.id).toBe('identity');
    expect(nextDiditPhase('kyc_2')?.id).toBe('identity');
  });

  it('kyc_3 → address', () => {
    expect(nextDiditPhase('kyc_3')?.id).toBe('address');
  });

  it('kyc_4 → null (every Didit phase complete)', () => {
    expect(nextDiditPhase('kyc_4')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Description copy — pinned at the contract level                   */
/* ------------------------------------------------------------------ */

describe('describe()', () => {
  it('identity completed line mentions verification', () => {
    const desc = IDENTITY_PHASE.describe(state({ customerKycLevel: 'kyc_3' }));
    expect(desc).toMatch(/verified/i);
  });

  it('address completed line mentions enhanced credential', () => {
    const desc = ADDRESS_PHASE.describe(state({ customerKycLevel: 'kyc_4' }));
    expect(desc).toMatch(/enhanced/i);
  });

  it('mint completed line mentions Sepolia', () => {
    const desc = NFT_MINT_PHASE.describe(
      state({ customerKycLevel: 'kyc_4', nftContractId: '00:abc' }),
    );
    expect(desc).toMatch(/sepolia/i);
  });
});
