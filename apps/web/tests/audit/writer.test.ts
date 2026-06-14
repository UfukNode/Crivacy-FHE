/**
 * Tests for the audit writer.
 *
 * The writer is the public hot path — every privileged route writes
 * through it, and a regression here has compliance consequences.
 * The suite covers:
 *
 *   * `writeAudit` happy path: INSERT issued, row hydrated, returned.
 *   * `writeAudit` validation: action / meta size / meta shape.
 *   * `writeAudit` `firmId` derivation (actor wins, then target).
 *   * `writeAudit` context defaults to EMPTY_CONTEXT.
 *   * `writeAudit` driver error surfacing.
 *   * `writeAuditBatch` happy path and row count assertion.
 *   * `writeAuditBatch` empty / too-large rejection.
 *   * `buildInsertRow` pure-function exposure (used by chain module).
 *   * Row hydration rejects malformed driver output.
 *
 * The mock DB is the `buildMockDb()` fixture; the test seeds rows
 * into its queue and asserts the chain steps captured during the
 * call.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  type AuditAction,
  AuditError,
  type InsertAuditRow,
  MAX_BATCH_SIZE,
  MAX_META_BYTES,
  type WriteAuditInput,
  adminUserActor,
  apiKeyActor,
  buildInsertRow,
  firmUserActor,
  noTarget,
  refTarget,
  systemActor,
  uuidTarget,
  writeAudit,
  writeAuditBatch,
} from '@/lib/audit';

import {
  type CapturedStep,
  FIXTURE_ADMIN_ID,
  FIXTURE_API_KEY_ID,
  FIXTURE_FIRM_ID,
  FIXTURE_FIRM_ID_B,
  FIXTURE_NOW,
  FIXTURE_REQUEST_ID,
  FIXTURE_USER_ID,
  type MockDbHandle,
  buildAuditRow,
  buildMockDb,
  buildSystemWriteInput,
  buildWriteInput,
} from './fixtures';

let mock: MockDbHandle;

beforeEach(() => {
  mock = buildMockDb();
});

/**
 * Pull the `.values(row)` payload out of the mock's captured step
 * list, narrowed to `InsertAuditRow` so tests can dot-access the
 * fields. The writer calls `.values(row)` exactly once per
 * `writeAudit` invocation, so the first matching step is the one
 * the assertions look at.
 */
function takeValuesPayload(steps: readonly CapturedStep[]): InsertAuditRow {
  const step = steps.find((s) => s.op === 'values');
  if (step === undefined) {
    throw new Error('expected a values() step but none was recorded');
  }
  return step.payload as InsertAuditRow;
}

/* ================================================================
 * writeAudit — happy path
 * ================================================================ */

describe('writeAudit — happy path', () => {
  it('inserts a row and returns the hydrated persisted shape', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({ id: 1, action: 'firm_user.login.success' })],
    });

    const result = await writeAudit(mock.db, buildWriteInput());

    expect(result.id).toBe(1);
    expect(result.action).toBe('firm_user.login.success');
    expect(result.actorKind).toBe('firm_user');
    expect(result.actorId).toBe(FIXTURE_USER_ID);
    expect(result.firmId).toBe(FIXTURE_FIRM_ID);
    expect(result.ts).toEqual(FIXTURE_NOW);
  });

  it('records insert → values → returning in that order', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({})],
    });

    await writeAudit(mock.db, buildWriteInput());

    const ops = mock.steps.map((s) => s.op);
    expect(ops).toEqual(['insert', 'values', 'returning']);
  });

  it('passes the built row into .values()', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({})],
    });

    await writeAudit(mock.db, buildWriteInput());

    const payload = takeValuesPayload(mock.steps);
    expect(payload.action).toBe('firm_user.login.success');
    expect(payload.actorKind).toBe('firm_user');
    expect(payload.actorId).toBe(FIXTURE_USER_ID);
    expect(payload.firmId).toBe(FIXTURE_FIRM_ID);
    expect(payload.targetKind).toBe('firm_user');
    expect(payload.targetId).toBe(FIXTURE_USER_ID);
    expect(payload.ip).toBe('10.0.0.1');
    expect(payload.userAgent).toBe('vitest/1.0');
    expect(payload.requestId).toBe(FIXTURE_REQUEST_ID);
    expect(payload.meta).toEqual({ source: 'unit-test' });
  });

  it('freezes the meta before passing to the driver', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({})],
    });

    await writeAudit(mock.db, buildWriteInput({ meta: { a: 1, b: 'two' } }));

    const payload = takeValuesPayload(mock.steps);
    expect(Object.isFrozen(payload.meta)).toBe(true);
    expect(payload.meta).toEqual({ a: 1, b: 'two' });
  });

  it('defaults context to EMPTY_CONTEXT when omitted', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({ ip: null, userAgent: null, requestId: null })],
    });

    const input: WriteAuditInput = {
      action: 'firm_user.login.success',
      actor: firmUserActor({
        id: FIXTURE_USER_ID,
        label: 'alice@acme.test',
        firmId: FIXTURE_FIRM_ID,
      }),
      target: noTarget(),
    };
    await writeAudit(mock.db, input);

    const payload = takeValuesPayload(mock.steps);
    expect(payload.ip).toBeNull();
    expect(payload.userAgent).toBeNull();
    expect(payload.requestId).toBeNull();
  });

  it('defaults meta to an empty object when omitted', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({ meta: {} })],
    });

    const input: WriteAuditInput = {
      action: 'system.worker.started',
      actor: systemActor('test-worker'),
      target: noTarget(),
    };
    await writeAudit(mock.db, input);

    const payload = takeValuesPayload(mock.steps);
    expect(payload.meta).toEqual({});
  });

  it('defaults ts to now() when omitted', async () => {
    mock.queue({ tag: 'insert', rows: [buildAuditRow({})] });

    // Construct a fresh input without `ts` — exactOptionalPropertyTypes
    // rejects `{ ts: undefined }` at the literal, so we simply omit
    // the key.
    const input: WriteAuditInput = {
      action: 'firm_user.login.success',
      actor: firmUserActor({
        id: FIXTURE_USER_ID,
        label: 'alice@acme.test',
        firmId: FIXTURE_FIRM_ID,
      }),
      target: uuidTarget({ kind: 'firm_user', id: FIXTURE_USER_ID }),
      meta: { source: 'unit-test' },
    };

    const before = Date.now();
    await writeAudit(mock.db, input);
    const after = Date.now();

    const payload = takeValuesPayload(mock.steps);
    expect(payload.ts).toBeInstanceOf(Date);
    expect(payload.ts.getTime()).toBeGreaterThanOrEqual(before);
    expect(payload.ts.getTime()).toBeLessThanOrEqual(after);
  });
});

/* ================================================================
 * writeAudit — firmId derivation
 * ================================================================ */

describe('writeAudit — firmId derivation', () => {
  it('uses the actor.firmId when actor is firm_user', async () => {
    mock.queue({ tag: 'insert', rows: [buildAuditRow({})] });
    await writeAudit(mock.db, buildWriteInput());
    const payload = takeValuesPayload(mock.steps);
    expect(payload.firmId).toBe(FIXTURE_FIRM_ID);
  });

  it('uses the actor.firmId when actor is api_key', async () => {
    mock.queue({ tag: 'insert', rows: [buildAuditRow({ actorKind: 'api_key' })] });
    await writeAudit(
      mock.db,
      buildWriteInput({
        actor: apiKeyActor({
          id: FIXTURE_API_KEY_ID,
          label: 'crv_live_abc',
          firmId: FIXTURE_FIRM_ID_B,
        }),
        target: noTarget(),
      }),
    );
    const payload = takeValuesPayload(mock.steps);
    expect(payload.firmId).toBe(FIXTURE_FIRM_ID_B);
  });

  it('admin actor produces firmId=null by default', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({ actorKind: 'admin_user', firmId: null })],
    });
    await writeAudit(
      mock.db,
      buildWriteInput({
        actor: adminUserActor({
          id: FIXTURE_ADMIN_ID,
          label: 'root@ops.test',
        }),
        target: noTarget(),
      }),
    );
    const payload = takeValuesPayload(mock.steps);
    expect(payload.firmId).toBeNull();
  });

  it('falls back to target.firm when actor is system and target kind=firm', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({ actorKind: 'system', firmId: FIXTURE_FIRM_ID })],
    });
    await writeAudit(
      mock.db,
      buildWriteInput({
        action: 'firm.updated',
        actor: systemActor('migration-worker'),
        target: uuidTarget({ kind: 'firm', id: FIXTURE_FIRM_ID }),
      }),
    );
    const payload = takeValuesPayload(mock.steps);
    expect(payload.firmId).toBe(FIXTURE_FIRM_ID);
  });

  it('actor.firmId wins over target.firm when both are present', async () => {
    mock.queue({ tag: 'insert', rows: [buildAuditRow({})] });
    await writeAudit(
      mock.db,
      buildWriteInput({
        actor: firmUserActor({
          id: FIXTURE_USER_ID,
          label: 'alice',
          firmId: FIXTURE_FIRM_ID,
        }),
        target: uuidTarget({ kind: 'firm', id: FIXTURE_FIRM_ID_B }),
      }),
    );
    const payload = takeValuesPayload(mock.steps);
    expect(payload.firmId).toBe(FIXTURE_FIRM_ID);
  });

  it('system actor with non-firm target produces firmId=null', async () => {
    mock.queue({
      tag: 'insert',
      rows: [
        buildAuditRow({
          actorKind: 'system',
          firmId: null,
          targetKind: null,
        }),
      ],
    });
    await writeAudit(mock.db, buildSystemWriteInput());
    const payload = takeValuesPayload(mock.steps);
    expect(payload.firmId).toBeNull();
  });
});

/* ================================================================
 * writeAudit — validation failures
 * ================================================================ */

describe('writeAudit — validation', () => {
  it('throws invalid_action for an unknown action string', async () => {
    const badInput = buildWriteInput({
      action: 'firm_user.login' as unknown as AuditAction,
    });
    await expect(writeAudit(mock.db, badInput)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'invalid_action';
    });
  });

  it('throws invalid_meta for a non-object meta', async () => {
    const badInput = buildWriteInput({
      meta: 'not-an-object' as unknown as Readonly<Record<string, unknown>>,
    });
    await expect(writeAudit(mock.db, badInput)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'invalid_meta';
    });
  });

  it('throws invalid_meta for a meta array', async () => {
    const badInput = buildWriteInput({
      meta: [1, 2, 3] as unknown as Readonly<Record<string, unknown>>,
    });
    await expect(writeAudit(mock.db, badInput)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'invalid_meta';
    });
  });

  it('throws invalid_meta for non-serializable meta', async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    const badInput = buildWriteInput({ meta: circular });
    await expect(writeAudit(mock.db, badInput)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'invalid_meta';
    });
  });

  it('throws meta_too_large when JSON exceeds MAX_META_BYTES', async () => {
    // Build a string whose JSON-encoded size exceeds the cap by a
    // comfortable margin. 70_000 chars > 64 KiB = 65_536 bytes.
    const huge = 'x'.repeat(70_000);
    const badInput = buildWriteInput({ meta: { big: huge } });
    await expect(writeAudit(mock.db, badInput)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'meta_too_large';
    });
  });

  it('accepts meta exactly at the MAX_META_BYTES boundary', async () => {
    mock.queue({ tag: 'insert', rows: [buildAuditRow({})] });
    // JSON envelope `{"big":"<string>"}` has 10 chars of overhead.
    const big = 'x'.repeat(MAX_META_BYTES - 10);
    await writeAudit(mock.db, buildWriteInput({ meta: { big } }));
    // No throw = pass.
  });

  it('throws invalid_context for an invalid ts Date', async () => {
    const badInput = buildWriteInput({ ts: new Date('not-a-date') });
    await expect(writeAudit(mock.db, badInput)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'invalid_context';
    });
  });
});

/* ================================================================
 * writeAudit — driver error surfacing
 * ================================================================ */

describe('writeAudit — driver error surfacing', () => {
  it('wraps driver errors into write_failed', async () => {
    mock.queue({
      tag: 'insert',
      rows: [],
      error: new Error('deadlock detected'),
    });

    await expect(writeAudit(mock.db, buildWriteInput())).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'write_failed';
    });
  });

  it('preserves the original driver error as cause', async () => {
    const inner = new Error('connection reset by peer');
    mock.queue({ tag: 'insert', rows: [], error: inner });

    try {
      await writeAudit(mock.db, buildWriteInput());
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditError);
      expect((err as unknown as { cause: Error }).cause).toBe(inner);
    }
  });

  it('throws write_failed when the returning() array is empty', async () => {
    mock.queue({ tag: 'insert', rows: [] });
    await expect(writeAudit(mock.db, buildWriteInput())).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'write_failed';
    });
  });

  it('throws write_failed on malformed hydrated row (unknown action)', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({ action: 'not.a.real.action' as unknown as AuditAction })],
    });
    await expect(writeAudit(mock.db, buildWriteInput())).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'write_failed';
    });
  });

  it('throws write_failed on malformed hydrated row (missing id)', async () => {
    mock.queue({
      tag: 'insert',
      rows: [{ ...buildAuditRow({}), id: null }],
    });
    await expect(writeAudit(mock.db, buildWriteInput())).rejects.toBeInstanceOf(AuditError);
  });
});

/* ================================================================
 * writeAuditBatch
 * ================================================================ */

describe('writeAuditBatch', () => {
  it('inserts all rows in one call', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({ id: 1 }), buildAuditRow({ id: 2 }), buildAuditRow({ id: 3 })],
    });

    const result = await writeAuditBatch(mock.db, [
      buildWriteInput(),
      buildWriteInput(),
      buildWriteInput(),
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]?.id).toBe(1);
    expect(result[1]?.id).toBe(2);
    expect(result[2]?.id).toBe(3);
  });

  it('issues a single insert call regardless of batch size', async () => {
    mock.queue({
      tag: 'insert',
      rows: [buildAuditRow({ id: 1 }), buildAuditRow({ id: 2 })],
    });

    await writeAuditBatch(mock.db, [buildWriteInput(), buildWriteInput()]);

    const inserts = mock.steps.filter((s) => s.op === 'insert');
    expect(inserts).toHaveLength(1);
  });

  it('throws batch_empty for an empty array', async () => {
    await expect(writeAuditBatch(mock.db, [])).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'batch_empty';
    });
  });

  it('throws batch_too_large when rows exceed MAX_BATCH_SIZE', async () => {
    const rows = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => buildWriteInput());
    await expect(writeAuditBatch(mock.db, rows)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'batch_too_large';
    });
  });

  it('accepts exactly MAX_BATCH_SIZE rows', async () => {
    mock.queue({
      tag: 'insert',
      rows: Array.from({ length: MAX_BATCH_SIZE }, (_, i) => buildAuditRow({ id: i + 1 })),
    });
    const rows = Array.from({ length: MAX_BATCH_SIZE }, () => buildWriteInput());
    const result = await writeAuditBatch(mock.db, rows);
    expect(result).toHaveLength(MAX_BATCH_SIZE);
  });

  it('throws write_failed if the returning count mismatches', async () => {
    mock.queue({ tag: 'insert', rows: [buildAuditRow({ id: 1 })] });
    const rows = [buildWriteInput(), buildWriteInput(), buildWriteInput()];
    await expect(writeAuditBatch(mock.db, rows)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'write_failed';
    });
  });

  it('wraps driver errors into write_failed', async () => {
    mock.queue({ tag: 'insert', rows: [], error: new Error('disk full') });
    await expect(writeAuditBatch(mock.db, [buildWriteInput()])).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'write_failed';
    });
  });

  it('validates every row — first invalid row kills the batch', async () => {
    const rows = [
      buildWriteInput(),
      buildWriteInput({
        action: 'bogus.action' as unknown as AuditAction,
      }),
    ];
    await expect(writeAuditBatch(mock.db, rows)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'invalid_action';
    });
    // The mock DB must not have been touched.
    expect(mock.steps).toEqual([]);
  });
});

/* ================================================================
 * buildInsertRow (pure)
 * ================================================================ */

describe('buildInsertRow', () => {
  it('produces the same shape as writeAudit hands to .values()', () => {
    const row = buildInsertRow(buildWriteInput());
    expect(row.action).toBe('firm_user.login.success');
    expect(row.actorKind).toBe('firm_user');
    expect(row.actorId).toBe(FIXTURE_USER_ID);
    expect(row.firmId).toBe(FIXTURE_FIRM_ID);
    expect(row.targetKind).toBe('firm_user');
    expect(row.targetId).toBe(FIXTURE_USER_ID);
    expect(row.targetRef).toBeNull();
    expect(row.ip).toBe('10.0.0.1');
    expect(row.userAgent).toBe('vitest/1.0');
    expect(row.requestId).toBe(FIXTURE_REQUEST_ID);
    expect(row.meta).toEqual({ source: 'unit-test' });
    expect(row.ts).toEqual(FIXTURE_NOW);
  });

  it('flattens a refTarget into targetKind + targetRef with null targetId', () => {
    const row = buildInsertRow(
      buildWriteInput({
        target: refTarget({ kind: 'credential', ref: 'chain:0xabc' }),
      }),
    );
    expect(row.targetKind).toBe('credential');
    expect(row.targetId).toBeNull();
    expect(row.targetRef).toBe('chain:0xabc');
  });

  it('flattens a noTarget into all-null target columns', () => {
    const row = buildInsertRow(buildSystemWriteInput());
    expect(row.targetKind).toBeNull();
    expect(row.targetId).toBeNull();
    expect(row.targetRef).toBeNull();
  });

  it('is pure — can be called without a database', () => {
    // No mock DB calls are made.
    const before = mock.steps.length;
    const _row = buildInsertRow(buildWriteInput());
    expect(mock.steps.length).toBe(before);
  });
});
