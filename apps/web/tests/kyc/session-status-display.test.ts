import { describe, expect, it } from 'vitest';
import {
  KYC_SESSION_STATUS_DISPLAY,
  isActiveSessionStatus,
  isStatusNeedingAttention,
  resolveSessionStatusDisplay,
} from '@/lib/kyc/session-status-display';

/**
 * The shared-types `KycStatus` union is the canonical 11-value set.
 * Hardcoding the list here is a regression guard: if someone adds a
 * 12th status to the union, this list goes stale and the
 * exhaustiveness assertion below fails — forcing them to either
 * extend `KYC_SESSION_STATUS_DISPLAY` or revisit the contract.
 */
const ALL_STATUSES = [
  'pending',
  'in_progress',
  'in_review',
  'identity_approved',
  'address_in_progress',
  'approved',
  'rejected',
  'expired',
  'revoked',
  'resubmission_pending',
  'kyc_expired',
] as const;

describe('KYC_SESSION_STATUS_DISPLAY', () => {
  it('covers every KycStatus value', () => {
    for (const status of ALL_STATUSES) {
      expect(KYC_SESSION_STATUS_DISPLAY[status]).toBeDefined();
      expect(KYC_SESSION_STATUS_DISPLAY[status].adminLabel).toBeTruthy();
      expect(KYC_SESSION_STATUS_DISPLAY[status].customerLabel).toBeTruthy();
    }
    expect(Object.keys(KYC_SESSION_STATUS_DISPLAY).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('uses StatusBadge variant names only', () => {
    const allowed = new Set(['success', 'warning', 'danger', 'info', 'neutral']);
    for (const status of ALL_STATUSES) {
      expect(allowed.has(KYC_SESSION_STATUS_DISPLAY[status].variant)).toBe(true);
    }
  });

  it('admin and customer labels diverge for at least the high-attention statuses', () => {
    // Sanity: in_review / resubmission_pending / kyc_expired should
    // not surface their raw admin label to customers — those are
    // jargon they wouldn't understand. Pinning the divergence keeps
    // future copy edits from accidentally collapsing the two fields.
    const technicalToFriendly: Array<[(typeof ALL_STATUSES)[number], string, string]> = [
      ['in_review', 'In Review', 'Under manual review'],
      ['resubmission_pending', 'Resubmission Pending', 'Resubmission required'],
      ['kyc_expired', 'KYC Expired', 'Credential expired'],
    ];
    for (const [status, expectedAdmin, expectedCustomer] of technicalToFriendly) {
      expect(KYC_SESSION_STATUS_DISPLAY[status].adminLabel).toBe(expectedAdmin);
      expect(KYC_SESSION_STATUS_DISPLAY[status].customerLabel).toBe(expectedCustomer);
      expect(KYC_SESSION_STATUS_DISPLAY[status].adminLabel).not.toBe(
        KYC_SESSION_STATUS_DISPLAY[status].customerLabel,
      );
    }
  });
});

describe('isActiveSessionStatus', () => {
  it('returns true for every state where the user owns an open session', () => {
    expect(isActiveSessionStatus('pending')).toBe(true);
    expect(isActiveSessionStatus('in_progress')).toBe(true);
    expect(isActiveSessionStatus('in_review')).toBe(true);
    expect(isActiveSessionStatus('identity_approved')).toBe(true);
    expect(isActiveSessionStatus('address_in_progress')).toBe(true);
    expect(isActiveSessionStatus('resubmission_pending')).toBe(true);
  });

  it('returns false for terminal failure / expiry states (user can retry)', () => {
    // kyc_expired notably is NOT active — re-verification needs a
    // fresh session, so the start CTA must remain reachable.
    expect(isActiveSessionStatus('approved')).toBe(false);
    expect(isActiveSessionStatus('rejected')).toBe(false);
    expect(isActiveSessionStatus('expired')).toBe(false);
    expect(isActiveSessionStatus('revoked')).toBe(false);
    expect(isActiveSessionStatus('kyc_expired')).toBe(false);
  });
});

describe('isStatusNeedingAttention', () => {
  it('flags the 3 statuses that require a banner', () => {
    expect(isStatusNeedingAttention('in_review')).toBe(true);
    expect(isStatusNeedingAttention('resubmission_pending')).toBe(true);
    expect(isStatusNeedingAttention('kyc_expired')).toBe(true);
  });

  it('does not flag normal in-progress or terminal states', () => {
    expect(isStatusNeedingAttention('pending')).toBe(false);
    expect(isStatusNeedingAttention('in_progress')).toBe(false);
    expect(isStatusNeedingAttention('approved')).toBe(false);
    expect(isStatusNeedingAttention('rejected')).toBe(false);
    expect(isStatusNeedingAttention('expired')).toBe(false);
    expect(isStatusNeedingAttention('revoked')).toBe(false);
  });
});

describe('resolveSessionStatusDisplay', () => {
  it('returns the canonical row for known statuses', () => {
    const row = resolveSessionStatusDisplay('approved');
    expect(row.variant).toBe('success');
    expect(row.adminLabel).toBe('Approved');
  });

  it('falls back gracefully for unknown statuses (forward-compat)', () => {
    const row = resolveSessionStatusDisplay('quarantined');
    expect(row.variant).toBe('neutral');
    expect(row.adminLabel).toBe('quarantined');
    expect(row.customerLabel).toBe('quarantined');
    expect(row.customerDescription).toBeNull();
  });
});
