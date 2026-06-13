import { describe, expect, it } from 'vitest';
import { mapPhaseStatus } from '@/server/handlers/sessions';

/**
 * Firm B2B contract pin. The 11 internal `kyc_session_status` values
 * collapse to 7 firm-facing `SessionPhase.status` values via
 * `mapPhaseStatus`. The earlier implementation silently returned
 * `'pending'` for any non-default state, which broke firm integrations
 * polling `GET /api/v1/sessions/:id` (in_review / resubmission_pending /
 * kyc_expired all looked identical to "user hasn't started yet"). This
 * test pins the full 11×2 matrix so a future enum addition either
 * extends `mapPhaseStatus` explicitly or fails the test.
 */
describe('mapPhaseStatus — identity phase', () => {
  it('pending → pending', () => {
    expect(mapPhaseStatus('pending', 'identity')).toBe('pending');
  });
  it('in_progress → in_progress', () => {
    expect(mapPhaseStatus('in_progress', 'identity')).toBe('in_progress');
  });
  it('in_review → in_review (compliance manual review surfaces to firm)', () => {
    expect(mapPhaseStatus('in_review', 'identity')).toBe('in_review');
  });
  it('resubmission_pending → resubmission_required (firm shows redo prompt)', () => {
    expect(mapPhaseStatus('resubmission_pending', 'identity')).toBe('resubmission_required');
  });
  it('identity_approved → approved (intermediate state, identity phase done)', () => {
    expect(mapPhaseStatus('identity_approved', 'identity')).toBe('approved');
  });
  it('address_in_progress → approved (identity already done; address now in flight)', () => {
    expect(mapPhaseStatus('address_in_progress', 'identity')).toBe('approved');
  });
  it('approved → approved', () => {
    expect(mapPhaseStatus('approved', 'identity')).toBe('approved');
  });
  it('rejected → rejected', () => {
    expect(mapPhaseStatus('rejected', 'identity')).toBe('rejected');
  });
  it('expired → expired', () => {
    expect(mapPhaseStatus('expired', 'identity')).toBe('expired');
  });
  it('revoked → expired (administrative revoke, terminal-failure surface)', () => {
    expect(mapPhaseStatus('revoked', 'identity')).toBe('expired');
  });
  it('kyc_expired → expired (Didit expiration policy, credential revoked on chain)', () => {
    expect(mapPhaseStatus('kyc_expired', 'identity')).toBe('expired');
  });
  it('unknown status → expired (defensive fallback, no silent pending)', () => {
    expect(mapPhaseStatus('quarantined', 'identity')).toBe('expired');
  });
});

describe('mapPhaseStatus — address phase', () => {
  it('pending → pending', () => {
    expect(mapPhaseStatus('pending', 'address')).toBe('pending');
  });
  it('in_progress → pending (identity-phase signal does not own address phase)', () => {
    expect(mapPhaseStatus('in_progress', 'address')).toBe('pending');
  });
  it('identity_approved → pending (phase 2 has not started)', () => {
    expect(mapPhaseStatus('identity_approved', 'address')).toBe('pending');
  });
  it('address_in_progress → in_progress (phase 2 active)', () => {
    expect(mapPhaseStatus('address_in_progress', 'address')).toBe('in_progress');
  });
  it('in_review → in_review (review applies to current phase, address)', () => {
    expect(mapPhaseStatus('in_review', 'address')).toBe('in_review');
  });
  it('resubmission_pending → resubmission_required', () => {
    expect(mapPhaseStatus('resubmission_pending', 'address')).toBe('resubmission_required');
  });
  it('approved → approved', () => {
    expect(mapPhaseStatus('approved', 'address')).toBe('approved');
  });
  it('rejected → rejected', () => {
    expect(mapPhaseStatus('rejected', 'address')).toBe('rejected');
  });
  it('expired → expired', () => {
    expect(mapPhaseStatus('expired', 'address')).toBe('expired');
  });
  it('revoked → expired', () => {
    expect(mapPhaseStatus('revoked', 'address')).toBe('expired');
  });
  it('kyc_expired → expired', () => {
    expect(mapPhaseStatus('kyc_expired', 'address')).toBe('expired');
  });
  it('unknown status → expired (defensive fallback)', () => {
    expect(mapPhaseStatus('quarantined', 'address')).toBe('expired');
  });
});

describe('mapPhaseStatus — regression guard', () => {
  it('never returns the legacy silent-pending fallback for any of the 5 new/non-default statuses', () => {
    // Pre-fix bug: in_review / resubmission_pending / kyc_expired /
    // expired / revoked all collapsed to 'pending' silently. Pin the
    // current explicit projections so a regression cannot reintroduce
    // the silent fallback.
    const newOrTerminalStatuses = [
      'in_review',
      'resubmission_pending',
      'kyc_expired',
      'expired',
      'revoked',
    ] as const;
    for (const s of newOrTerminalStatuses) {
      expect(mapPhaseStatus(s, 'identity')).not.toBe('pending');
      expect(mapPhaseStatus(s, 'address')).not.toBe('pending');
    }
  });
});
