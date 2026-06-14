/**
 * Tests for the branded types + constant tuples exported by
 * `@crivacy-fhe/adapter-didit` types. We cannot assert nominal typing at runtime,
 * so these tests pin the runtime enumerations and the unchecked
 * constructors instead.
 */

import { describe, expect, it } from 'vitest';

import {
  DIDIT_DECISION_STATUSES,
  DIDIT_WORKFLOW_TYPES,
  INTERNAL_VERIFICATION_OUTCOMES,
  asDiditSessionIdUnchecked,
  asDiditVendorDataUnchecked,
  asDiditWorkflowIdUnchecked,
} from '@crivacy-fhe/adapter-didit';

describe('DIDIT_DECISION_STATUSES', () => {
  it('matches the nine documented status tokens Didit emits', () => {
    expect(DIDIT_DECISION_STATUSES).toEqual([
      'Not Started',
      'In Progress',
      'In Review',
      'Resubmitted',
      'Approved',
      'Declined',
      'Expired',
      'Abandoned',
      'Kyc Expired',
    ]);
  });

  it('is frozen so callers cannot push new statuses in at runtime', () => {
    expect(Object.isFrozen(DIDIT_DECISION_STATUSES)).toBe(true);
    expect(() => {
      (DIDIT_DECISION_STATUSES as unknown as string[]).push('Hacked');
    }).toThrow();
  });
});

describe('INTERNAL_VERIFICATION_OUTCOMES', () => {
  it('lists the four internal outcomes', () => {
    expect(INTERNAL_VERIFICATION_OUTCOMES).toEqual([
      'passed',
      'failed',
      'manual_review',
      'pending',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(INTERNAL_VERIFICATION_OUTCOMES)).toBe(true);
  });
});

describe('DIDIT_WORKFLOW_TYPES', () => {
  it('lists the two workflow tags', () => {
    expect(DIDIT_WORKFLOW_TYPES).toEqual(['kyc', 'address']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DIDIT_WORKFLOW_TYPES)).toBe(true);
  });
});

describe('unchecked brand constructors', () => {
  it('returns the input string unchanged (asDiditSessionIdUnchecked)', () => {
    const raw = 'sess_01HYTEST00000000000000000';
    const branded = asDiditSessionIdUnchecked(raw);
    expect(branded).toBe(raw);
  });

  it('returns the input string unchanged (asDiditWorkflowIdUnchecked)', () => {
    const raw = '2ab9f298-699c-4b2c-9ce9-6246c17c6c25';
    const branded = asDiditWorkflowIdUnchecked(raw);
    expect(branded).toBe(raw);
  });

  it('returns the input string unchanged (asDiditVendorDataUnchecked)', () => {
    const raw = 'user_0123456789';
    const branded = asDiditVendorDataUnchecked(raw);
    expect(branded).toBe(raw);
  });

  it('does not validate — empty string flows through', () => {
    expect(asDiditSessionIdUnchecked('')).toBe('');
    expect(asDiditWorkflowIdUnchecked('')).toBe('');
    expect(asDiditVendorDataUnchecked('')).toBe('');
  });
});
