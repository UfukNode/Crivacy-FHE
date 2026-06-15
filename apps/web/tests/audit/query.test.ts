/**
 * Tests for the audit query helpers.
 *
 * These tests cover:
 *
 *   * Cursor encoding / decoding round-trips correctly.
 *   * Decoding rejects garbage, bad base64, bad JSON, wrong fields.
 *   * `listByFirm` / `listByActor` / `listByTarget` / `listGlobal`
 *     all go through the mock select chain.
 *   * Keyset over-fetch: n+1 rows queued, n returned, hasMore=true,
 *     nextCursor encoded from the tail.
 *   * No over-fetch: n rows queued, n returned, hasMore=false,
 *     nextCursor=null.
 *   * `limit` clamps to `MAX_QUERY_LIMIT` and rejects non-positive.
 *   * `from` > `to` rejected with invalid_range.
 *   * `action` / `actionDomain` filters go through the WHERE clause.
 *   * UUID checks on firmId / actorId / targetId reject garbage.
 *   * Driver errors wrap into `read_failed`.
 *   * Row hydration rejects malformed driver output.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  AuditError,
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  decodeCursor,
  encodeCursor,
  listByActor,
  listByFirm,
  listByTarget,
  listGlobal,
} from '@/lib/audit';

import {
  FIXTURE_FIRM_ID,
  FIXTURE_NOW,
  FIXTURE_SESSION_ID,
  FIXTURE_USER_ID,
  type MockDbHandle,
  buildAuditRow,
  buildMockDb,
} from './fixtures';

let mock: MockDbHandle;

beforeEach(() => {
  mock = buildMockDb();
});

/* ================================================================
 * Cursor encode / decode
 * ================================================================ */

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a cursor exactly', () => {
    const original = { ts: FIXTURE_NOW, id: 42 };
    const encoded = encodeCursor(original);
    const decoded = decodeCursor(encoded);
    expect(decoded.ts.getTime()).toBe(FIXTURE_NOW.getTime());
    expect(decoded.id).toBe(42);
  });

  it('encoded value is URL-safe (no +, /, =)', () => {
    const encoded = encodeCursor({ ts: FIXTURE_NOW, id: 42 });
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });

  it('rejects garbage cursor with invalid_cursor', () => {
    expect(() => decodeCursor('not-base64!')).toThrow(AuditError);
  });

  it('rejects empty cursor', () => {
    expect(() => decodeCursor('')).toThrow(AuditError);
  });

  it('rejects non-JSON base64', () => {
    const encoded = Buffer.from('hello world', 'utf8').toString('base64url');
    expect(() => decodeCursor(encoded)).toThrow(/JSON/);
  });

  it('rejects JSON that is a primitive (not an object)', () => {
    const encoded = Buffer.from('42', 'utf8').toString('base64url');
    expect(() => decodeCursor(encoded)).toThrow(/object/);
  });

  it('rejects JSON arrays even though typeof is object', () => {
    // Arrays pass the `typeof === 'object'` check but fail at the
    // `tsRaw` field lookup — either way the error code is
    // invalid_cursor.
    const encoded = Buffer.from('[1,2,3]', 'utf8').toString('base64url');
    try {
      decodeCursor(encoded);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditError);
      expect((err as AuditError).code).toBe('invalid_cursor');
    }
  });

  it('rejects cursor with missing ts', () => {
    const encoded = Buffer.from(JSON.stringify({ id: 42 }), 'utf8').toString('base64url');
    expect(() => decodeCursor(encoded)).toThrow(/ts/);
  });

  it('rejects cursor with non-integer id', () => {
    const encoded = Buffer.from(
      JSON.stringify({ ts: FIXTURE_NOW.toISOString(), id: 1.5 }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(encoded)).toThrow(/id/);
  });

  it('rejects cursor with negative id', () => {
    const encoded = Buffer.from(
      JSON.stringify({ ts: FIXTURE_NOW.toISOString(), id: -1 }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(encoded)).toThrow(/id/);
  });

  it('rejects cursor with invalid ts string', () => {
    const encoded = Buffer.from(JSON.stringify({ ts: 'not-a-date', id: 5 }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(encoded)).toThrow(/ts/);
  });

  it('throws AuditError with code invalid_cursor', () => {
    try {
      decodeCursor('!!!');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditError);
      expect((err as AuditError).code).toBe('invalid_cursor');
    }
  });
});

/* ================================================================
 * listByFirm
 * ================================================================ */

describe('listByFirm', () => {
  it('fetches rows and hydrates them', async () => {
    mock.queue({
      tag: 'select',
      rows: [buildAuditRow({ id: 1 }), buildAuditRow({ id: 2 })],
    });

    const result = await listByFirm(mock.db, FIXTURE_FIRM_ID);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.id).toBe(1);
    expect(result.rows[1]?.id).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('goes through select → from → where → orderBy → limit', async () => {
    mock.queue({ tag: 'select', rows: [buildAuditRow({})] });
    await listByFirm(mock.db, FIXTURE_FIRM_ID);

    const ops = mock.steps.map((s) => s.op);
    expect(ops).toEqual(['select', 'from', 'where', 'orderBy', 'limit']);
  });

  it('over-fetches by 1 to compute hasMore', async () => {
    mock.queue({
      tag: 'select',
      rows: Array.from({ length: DEFAULT_QUERY_LIMIT + 1 }, (_, i) => buildAuditRow({ id: i + 1 })),
    });

    const result = await listByFirm(mock.db, FIXTURE_FIRM_ID);
    expect(result.rows).toHaveLength(DEFAULT_QUERY_LIMIT);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it('nextCursor decodes to the tail of the returned page', async () => {
    const tail = buildAuditRow({
      id: DEFAULT_QUERY_LIMIT,
      ts: new Date('2026-04-10T00:00:00.000Z'),
    });
    const overflow = Array.from({ length: DEFAULT_QUERY_LIMIT + 1 }, (_, i) =>
      i === DEFAULT_QUERY_LIMIT - 1 ? tail : buildAuditRow({ id: i + 1 }),
    );
    mock.queue({ tag: 'select', rows: overflow });

    const result = await listByFirm(mock.db, FIXTURE_FIRM_ID);
    expect(result.nextCursor).not.toBeNull();
    const decoded = decodeCursor(result.nextCursor as string);
    expect(decoded.id).toBe(DEFAULT_QUERY_LIMIT);
    expect(decoded.ts.getTime()).toBe(new Date('2026-04-10T00:00:00.000Z').getTime());
  });

  it('uses DEFAULT_QUERY_LIMIT when limit is omitted', async () => {
    mock.queue({ tag: 'select', rows: [buildAuditRow({})] });
    await listByFirm(mock.db, FIXTURE_FIRM_ID);
    const limitStep = mock.steps.find((s) => s.op === 'limit');
    expect(limitStep?.payload).toBe(DEFAULT_QUERY_LIMIT + 1);
  });

  it('clamps explicit limit to MAX_QUERY_LIMIT', async () => {
    mock.queue({ tag: 'select', rows: [buildAuditRow({})] });
    await listByFirm(mock.db, FIXTURE_FIRM_ID, { limit: 10_000 });
    const limitStep = mock.steps.find((s) => s.op === 'limit');
    expect(limitStep?.payload).toBe(MAX_QUERY_LIMIT + 1);
  });

  it('rejects non-positive limit', async () => {
    await expect(listByFirm(mock.db, FIXTURE_FIRM_ID, { limit: 0 })).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'read_failed';
    });
  });

  it('rejects non-integer limit', async () => {
    await expect(listByFirm(mock.db, FIXTURE_FIRM_ID, { limit: 3.14 })).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'read_failed';
    });
  });

  it('rejects invalid firmId (non-uuid)', async () => {
    await expect(listByFirm(mock.db, 'not-a-uuid')).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'read_failed';
    });
  });

  it('rejects from > to with invalid_range', async () => {
    await expect(
      listByFirm(mock.db, FIXTURE_FIRM_ID, {
        from: new Date('2026-04-10T00:00:00.000Z'),
        to: new Date('2026-04-09T00:00:00.000Z'),
      }),
    ).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'invalid_range';
    });
  });

  it('accepts from <= to', async () => {
    mock.queue({ tag: 'select', rows: [buildAuditRow({})] });
    await listByFirm(mock.db, FIXTURE_FIRM_ID, {
      from: new Date('2026-04-09T00:00:00.000Z'),
      to: new Date('2026-04-10T00:00:00.000Z'),
    });
    // No throw = pass.
  });

  it('wraps driver errors into read_failed', async () => {
    mock.queue({ tag: 'select', rows: [], error: new Error('boom') });
    await expect(listByFirm(mock.db, FIXTURE_FIRM_ID)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'read_failed';
    });
  });

  it('rejects invalid action filter', async () => {
    await expect(
      listByFirm(mock.db, FIXTURE_FIRM_ID, {
        action: 'not.a.real.action' as unknown as 'firm_user.login.success',
      }),
    ).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'invalid_action';
    });
  });

  it('rejects actionDomain containing %', async () => {
    await expect(listByFirm(mock.db, FIXTURE_FIRM_ID, { actionDomain: 'firm%' })).rejects.toSatisfy(
      (err) => {
        return err instanceof AuditError && err.code === 'read_failed';
      },
    );
  });

  it('rejects empty actionDomain', async () => {
    await expect(listByFirm(mock.db, FIXTURE_FIRM_ID, { actionDomain: '' })).rejects.toSatisfy(
      (err) => {
        return err instanceof AuditError && err.code === 'read_failed';
      },
    );
  });

  it('accepts a valid actionDomain filter', async () => {
    mock.queue({ tag: 'select', rows: [buildAuditRow({})] });
    await listByFirm(mock.db, FIXTURE_FIRM_ID, { actionDomain: 'firm_user' });
    // No throw = pass.
  });
});

/* ================================================================
 * listByActor
 * ================================================================ */

describe('listByActor', () => {
  it('fetches rows for a uuid actorId', async () => {
    mock.queue({
      tag: 'select',
      rows: [buildAuditRow({ id: 1 })],
    });
    const result = await listByActor(mock.db, {
      actorKind: 'firm_user',
      actorId: FIXTURE_USER_ID,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.actorId).toBe(FIXTURE_USER_ID);
  });

  it('accepts actorId=null (for system events)', async () => {
    mock.queue({
      tag: 'select',
      rows: [
        buildAuditRow({
          actorKind: 'system',
          actorId: null,
          firmId: null,
          targetKind: null,
          targetId: null,
        }),
      ],
    });
    const result = await listByActor(mock.db, {
      actorKind: 'system',
      actorId: null,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.actorKind).toBe('system');
  });

  it('rejects non-uuid actorId', async () => {
    await expect(
      listByActor(mock.db, { actorKind: 'firm_user', actorId: 'bad' }),
    ).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'read_failed';
    });
  });
});

/* ================================================================
 * listByTarget
 * ================================================================ */

describe('listByTarget', () => {
  it('fetches rows by targetId', async () => {
    mock.queue({
      tag: 'select',
      rows: [buildAuditRow({ targetKind: 'kyc_session', targetId: FIXTURE_SESSION_ID })],
    });
    const result = await listByTarget(mock.db, {
      targetKind: 'kyc_session',
      targetId: FIXTURE_SESSION_ID,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.targetId).toBe(FIXTURE_SESSION_ID);
  });

  it('fetches rows by targetRef', async () => {
    mock.queue({
      tag: 'select',
      rows: [
        buildAuditRow({ targetKind: 'credential', targetId: null, targetRef: 'chain:0xabc' }),
      ],
    });
    const result = await listByTarget(mock.db, {
      targetKind: 'credential',
      targetRef: 'chain:0xabc',
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.targetRef).toBe('chain:0xabc');
  });

  it('rejects when neither targetId nor targetRef provided', async () => {
    await expect(listByTarget(mock.db, { targetKind: 'credential' })).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'read_failed';
    });
  });

  it('rejects non-uuid targetId', async () => {
    await expect(
      listByTarget(mock.db, { targetKind: 'firm_user', targetId: 'bad' }),
    ).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'read_failed';
    });
  });
});

/* ================================================================
 * listGlobal
 * ================================================================ */

describe('listGlobal', () => {
  it('fetches the unscoped set', async () => {
    mock.queue({
      tag: 'select',
      rows: [buildAuditRow({ id: 1 }), buildAuditRow({ id: 2 })],
    });
    const result = await listGlobal(mock.db);
    expect(result.rows).toHaveLength(2);
  });

  it('respects the limit option', async () => {
    mock.queue({
      tag: 'select',
      rows: Array.from({ length: 5 }, (_, i) => buildAuditRow({ id: i + 1 })),
    });
    await listGlobal(mock.db, { limit: 4 });
    const limitStep = mock.steps.find((s) => s.op === 'limit');
    expect(limitStep?.payload).toBe(5); // over-fetch
  });

  it('accepts a cursor and produces the WHERE predicate', async () => {
    mock.queue({
      tag: 'select',
      rows: [buildAuditRow({ id: 1 })],
    });
    const cursor = { ts: FIXTURE_NOW, id: 100 };
    await listGlobal(mock.db, { cursor });
    const whereSteps = mock.steps.filter((s) => s.op === 'where');
    expect(whereSteps.length).toBeGreaterThan(0);
  });
});

/* ================================================================
 * Row hydration
 * ================================================================ */

describe('row hydration', () => {
  it('rejects a row with unknown action', async () => {
    mock.queue({
      tag: 'select',
      rows: [buildAuditRow({ action: 'bogus.action' as unknown as 'firm_user.login.success' })],
    });
    await expect(listByFirm(mock.db, FIXTURE_FIRM_ID)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'read_failed';
    });
  });

  it('rejects a row with unknown targetKind', async () => {
    mock.queue({
      tag: 'select',
      rows: [{ ...buildAuditRow({}), targetKind: 'bogus_kind' }],
    });
    await expect(listByFirm(mock.db, FIXTURE_FIRM_ID)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'read_failed';
    });
  });

  it('rejects a row with unknown actorKind', async () => {
    mock.queue({
      tag: 'select',
      rows: [{ ...buildAuditRow({}), actorKind: 'bogus_kind' }],
    });
    await expect(listByFirm(mock.db, FIXTURE_FIRM_ID)).rejects.toSatisfy((err) => {
      return err instanceof AuditError && err.code === 'read_failed';
    });
  });

  it('accepts null targetKind on system rows', async () => {
    mock.queue({
      tag: 'select',
      rows: [
        buildAuditRow({
          actorKind: 'system',
          actorId: null,
          firmId: null,
          targetKind: null,
          targetId: null,
          targetRef: null,
        }),
      ],
    });
    const result = await listGlobal(mock.db);
    expect(result.rows[0]?.targetKind).toBeNull();
  });

  it('parses ts from an ISO string if the driver returned a string', async () => {
    mock.queue({
      tag: 'select',
      rows: [{ ...buildAuditRow({}), ts: '2026-04-10T09:30:00.000Z' }],
    });
    const result = await listByFirm(mock.db, FIXTURE_FIRM_ID);
    expect(result.rows[0]?.ts).toBeInstanceOf(Date);
    expect(result.rows[0]?.ts.getTime()).toBe(new Date('2026-04-10T09:30:00.000Z').getTime());
  });

  it('rejects a row where ts is not a Date or parsable string', async () => {
    mock.queue({
      tag: 'select',
      rows: [{ ...buildAuditRow({}), ts: { bad: 'shape' } }],
    });
    await expect(listByFirm(mock.db, FIXTURE_FIRM_ID)).rejects.toBeInstanceOf(AuditError);
  });
});
