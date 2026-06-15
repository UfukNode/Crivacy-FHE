/**
 * Tests for the audit target constructors and row-shape mapper.
 *
 * `AuditTarget` is a discriminated union over `none | uuid | ref`.
 * The writer accepts a constructed target and calls `targetToRow`
 * to flatten it into the three-column persisted shape. These tests
 * cover:
 *
 *   * `noTarget` returns a frozen singleton with `kind='none'`.
 *   * `uuidTarget` validates kind / id and optionally accepts a ref.
 *   * `refTarget` validates kind / ref and optionally accepts an id.
 *   * `targetToRow` flattens each variant correctly.
 *   * Ref strings are bounded to 256 chars and non-empty.
 *   * Unknown `kind` values are rejected.
 */

import { describe, expect, it } from 'vitest';

import {
  AuditError,
  type AuditTargetKind,
  noTarget,
  refTarget,
  targetToRow,
  uuidTarget,
} from '@/lib/audit';

import { FIXTURE_SESSION_ID, FIXTURE_USER_ID } from './fixtures';

describe('noTarget', () => {
  it('returns a frozen singleton with kind=none', () => {
    const t = noTarget();
    expect(t).toEqual({ kind: 'none' });
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('returns the same singleton on repeated calls', () => {
    expect(noTarget()).toBe(noTarget());
  });

  it('targetToRow maps to all-null shape', () => {
    expect(targetToRow(noTarget())).toEqual({
      targetKind: null,
      targetId: null,
      targetRef: null,
    });
  });
});

describe('uuidTarget', () => {
  it('constructs a frozen target with kind + id', () => {
    const t = uuidTarget({ kind: 'firm_user', id: FIXTURE_USER_ID });
    expect(t.kind).toBe('firm_user');
    expect(t.id).toBe(FIXTURE_USER_ID);
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('accepts an optional ref', () => {
    const t = uuidTarget({
      kind: 'kyc_session',
      id: FIXTURE_SESSION_ID,
      ref: 'didit-session-abc',
    });
    expect(t.ref).toBe('didit-session-abc');
  });

  it('rejects bad uuid', () => {
    expect(() => uuidTarget({ kind: 'firm_user', id: 'not-a-uuid' })).toThrow(AuditError);
  });

  it('rejects unknown kind', () => {
    expect(() =>
      uuidTarget({
        kind: 'bogus' as AuditTargetKind,
        id: FIXTURE_USER_ID,
      }),
    ).toThrow(/audit_target_kind/);
  });

  it('rejects empty ref', () => {
    expect(() =>
      uuidTarget({
        kind: 'kyc_session',
        id: FIXTURE_SESSION_ID,
        ref: '',
      }),
    ).toThrow(/non-empty/);
  });

  it('rejects ref longer than 256 chars', () => {
    expect(() =>
      uuidTarget({
        kind: 'credential',
        id: FIXTURE_USER_ID,
        ref: 'a'.repeat(257),
      }),
    ).toThrow(/at most 256/);
  });

  it('accepts ref at exactly 256 chars', () => {
    const ref = 'a'.repeat(256);
    const t = uuidTarget({
      kind: 'credential',
      id: FIXTURE_USER_ID,
      ref,
    });
    expect(t.ref).toBe(ref);
  });

  it('targetToRow flattens to { kind, id, ref }', () => {
    const row = targetToRow(
      uuidTarget({
        kind: 'firm_user',
        id: FIXTURE_USER_ID,
      }),
    );
    expect(row).toEqual({
      targetKind: 'firm_user',
      targetId: FIXTURE_USER_ID,
      targetRef: null,
    });
  });

  it('targetToRow includes ref when set', () => {
    const row = targetToRow(
      uuidTarget({
        kind: 'kyc_session',
        id: FIXTURE_SESSION_ID,
        ref: 'didit-123',
      }),
    );
    expect(row).toEqual({
      targetKind: 'kyc_session',
      targetId: FIXTURE_SESSION_ID,
      targetRef: 'didit-123',
    });
  });
});

describe('refTarget', () => {
  it('constructs a frozen target with kind + ref', () => {
    const t = refTarget({
      kind: 'credential',
      ref: 'chain:0x1234abcd',
    });
    expect(t.kind).toBe('credential');
    expect(t.ref).toBe('chain:0x1234abcd');
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('accepts an optional id', () => {
    const t = refTarget({
      kind: 'webhook_delivery',
      ref: 'evt_abc',
      id: FIXTURE_SESSION_ID,
    });
    expect(t.id).toBe(FIXTURE_SESSION_ID);
  });

  it('rejects unknown kind', () => {
    expect(() =>
      refTarget({
        kind: 'bogus' as AuditTargetKind,
        ref: 'anything',
      }),
    ).toThrow(/audit_target_kind/);
  });

  it('rejects empty ref', () => {
    expect(() =>
      refTarget({
        kind: 'credential',
        ref: '',
      }),
    ).toThrow(/non-empty/);
  });

  it('rejects ref longer than 256', () => {
    expect(() =>
      refTarget({
        kind: 'webhook_delivery',
        ref: 'a'.repeat(257),
      }),
    ).toThrow(/at most 256/);
  });

  it('rejects bad id uuid', () => {
    expect(() =>
      refTarget({
        kind: 'webhook_delivery',
        ref: 'evt_abc',
        id: 'bad',
      }),
    ).toThrow(/uuid/);
  });

  it('targetToRow flattens ref-only target', () => {
    const row = targetToRow(
      refTarget({
        kind: 'credential',
        ref: 'chain:0xdeadbeef',
      }),
    );
    expect(row).toEqual({
      targetKind: 'credential',
      targetId: null,
      targetRef: 'chain:0xdeadbeef',
    });
  });

  it('targetToRow includes both when both are set', () => {
    const row = targetToRow(
      refTarget({
        kind: 'webhook_delivery',
        ref: 'evt_abc',
        id: FIXTURE_SESSION_ID,
      }),
    );
    expect(row).toEqual({
      targetKind: 'webhook_delivery',
      targetId: FIXTURE_SESSION_ID,
      targetRef: 'evt_abc',
    });
  });
});

describe('AuditError code for target failures', () => {
  it('throws with code invalid_target on bad kind', () => {
    try {
      uuidTarget({ kind: 'x' as AuditTargetKind, id: FIXTURE_USER_ID });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditError);
      expect((err as AuditError).code).toBe('invalid_target');
    }
  });
});
