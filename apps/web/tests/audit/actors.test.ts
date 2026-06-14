/**
 * Tests for the audit actor constructors.
 *
 * The writer only accepts `AuditActor` values constructed via these
 * helpers — an ad-hoc object literal cannot satisfy the type-level
 * contract (fields like `kind` are typed as literals not strings).
 * We assert that:
 *
 *   * Each constructor builds a frozen object with the correct kind.
 *   * UUID fields reject non-uuid / wrong version / non-string input.
 *   * Labels reject empty strings and values over `MAX_LABEL_LENGTH`.
 *   * `actorToRow` maps every variant to the persisted row shape the
 *     writer expects.
 */

import { describe, expect, it } from 'vitest';

import {
  AuditError,
  actorToRow,
  adminUserActor,
  apiKeyActor,
  firmUserActor,
  systemActor,
} from '@/lib/audit';

import { FIXTURE_ADMIN_ID, FIXTURE_API_KEY_ID, FIXTURE_FIRM_ID, FIXTURE_USER_ID } from './fixtures';

describe('firmUserActor', () => {
  it('constructs a frozen actor with kind=firm_user', () => {
    const actor = firmUserActor({
      id: FIXTURE_USER_ID,
      label: 'alice@acme.test',
      firmId: FIXTURE_FIRM_ID,
    });
    expect(actor.kind).toBe('firm_user');
    expect(actor.id).toBe(FIXTURE_USER_ID);
    expect(actor.label).toBe('alice@acme.test');
    expect(actor.firmId).toBe(FIXTURE_FIRM_ID);
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it('rejects non-uuid id', () => {
    expect(() =>
      firmUserActor({
        id: 'not-a-uuid',
        label: 'alice',
        firmId: FIXTURE_FIRM_ID,
      }),
    ).toThrow(AuditError);
  });

  it('rejects uuid v1 (wrong version)', () => {
    expect(() =>
      firmUserActor({
        id: '11111111-1111-1111-8111-111111111111',
        label: 'alice',
        firmId: FIXTURE_FIRM_ID,
      }),
    ).toThrow(/uuid v4/);
  });

  it('rejects empty label', () => {
    expect(() =>
      firmUserActor({
        id: FIXTURE_USER_ID,
        label: '',
        firmId: FIXTURE_FIRM_ID,
      }),
    ).toThrow(/non-empty/);
  });

  it('rejects labels longer than 320 chars', () => {
    const longLabel = 'a'.repeat(321);
    expect(() =>
      firmUserActor({
        id: FIXTURE_USER_ID,
        label: longLabel,
        firmId: FIXTURE_FIRM_ID,
      }),
    ).toThrow(/at most 320/);
  });

  it('accepts exactly 320 chars', () => {
    const label = 'a'.repeat(320);
    const actor = firmUserActor({
      id: FIXTURE_USER_ID,
      label,
      firmId: FIXTURE_FIRM_ID,
    });
    expect(actor.label).toBe(label);
  });

  it('rejects non-uuid firmId', () => {
    expect(() =>
      firmUserActor({
        id: FIXTURE_USER_ID,
        label: 'alice',
        firmId: 'nope',
      }),
    ).toThrow(/firmId/);
  });

  it('AuditError code is invalid_actor', () => {
    try {
      firmUserActor({ id: 'bad', label: 'x', firmId: FIXTURE_FIRM_ID });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditError);
      expect((err as AuditError).code).toBe('invalid_actor');
    }
  });
});

describe('adminUserActor', () => {
  it('constructs a frozen actor with kind=admin_user', () => {
    const actor = adminUserActor({
      id: FIXTURE_ADMIN_ID,
      label: 'root@ops.test',
    });
    expect(actor.kind).toBe('admin_user');
    expect(actor.id).toBe(FIXTURE_ADMIN_ID);
    expect(actor.label).toBe('root@ops.test');
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it('rejects bad uuid', () => {
    expect(() => adminUserActor({ id: 'bad', label: 'x' })).toThrow(AuditError);
  });

  it('rejects empty label', () => {
    expect(() => adminUserActor({ id: FIXTURE_ADMIN_ID, label: '' })).toThrow(/non-empty/);
  });
});

describe('apiKeyActor', () => {
  it('constructs a frozen actor with kind=api_key', () => {
    const actor = apiKeyActor({
      id: FIXTURE_API_KEY_ID,
      label: 'crv_live_abc123def456',
      firmId: FIXTURE_FIRM_ID,
    });
    expect(actor.kind).toBe('api_key');
    expect(actor.id).toBe(FIXTURE_API_KEY_ID);
    expect(actor.label).toBe('crv_live_abc123def456');
    expect(actor.firmId).toBe(FIXTURE_FIRM_ID);
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it('rejects bad firmId', () => {
    expect(() =>
      apiKeyActor({
        id: FIXTURE_API_KEY_ID,
        label: 'crv_live_abc',
        firmId: 'not-a-uuid',
      }),
    ).toThrow(/firmId/);
  });

  it('rejects label at length 321', () => {
    expect(() =>
      apiKeyActor({
        id: FIXTURE_API_KEY_ID,
        label: 'a'.repeat(321),
        firmId: FIXTURE_FIRM_ID,
      }),
    ).toThrow(/320/);
  });
});

describe('systemActor', () => {
  it('constructs a frozen actor with kind=system', () => {
    const actor = systemActor('backup-worker');
    expect(actor.kind).toBe('system');
    expect(actor.label).toBe('backup-worker');
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it('rejects empty label', () => {
    expect(() => systemActor('')).toThrow(/non-empty/);
  });

  it('rejects non-string label at runtime', () => {
    expect(() => systemActor(42 as unknown as string)).toThrow(AuditError);
  });
});

describe('actorToRow', () => {
  it('maps firm_user to row shape with firmId set', () => {
    const row = actorToRow(
      firmUserActor({
        id: FIXTURE_USER_ID,
        label: 'alice@acme.test',
        firmId: FIXTURE_FIRM_ID,
      }),
    );
    expect(row).toEqual({
      actorKind: 'firm_user',
      actorId: FIXTURE_USER_ID,
      actorLabel: 'alice@acme.test',
      firmId: FIXTURE_FIRM_ID,
    });
  });

  it('maps admin_user to row shape with firmId=null', () => {
    const row = actorToRow(
      adminUserActor({
        id: FIXTURE_ADMIN_ID,
        label: 'root@ops.test',
      }),
    );
    expect(row).toEqual({
      actorKind: 'admin_user',
      actorId: FIXTURE_ADMIN_ID,
      actorLabel: 'root@ops.test',
      firmId: null,
    });
  });

  it('maps api_key to row shape with firmId set', () => {
    const row = actorToRow(
      apiKeyActor({
        id: FIXTURE_API_KEY_ID,
        label: 'crv_live_abc',
        firmId: FIXTURE_FIRM_ID,
      }),
    );
    expect(row).toEqual({
      actorKind: 'api_key',
      actorId: FIXTURE_API_KEY_ID,
      actorLabel: 'crv_live_abc',
      firmId: FIXTURE_FIRM_ID,
    });
  });

  it('maps system to row shape with actorId=null and firmId=null', () => {
    const row = actorToRow(systemActor('backup-worker'));
    expect(row).toEqual({
      actorKind: 'system',
      actorId: null,
      actorLabel: 'backup-worker',
      firmId: null,
    });
  });
});
