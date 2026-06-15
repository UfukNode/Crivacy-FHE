/**
 * F-A1-AUDIT-ATOMIC-001 — observability hardening tests.
 *
 * The atomicity guarantee itself (action UPDATE rolls back when
 * writeAudit throws inside the same tx) requires a real Postgres
 * connection — a vitest mock cannot model ACID rollback semantics.
 * That test lives in the RLS integration suite (gated by
 * `DATABASE_URL_ADMIN` + `DATABASE_URL_APP`).
 *
 * What this file covers:
 *
 *   * The error-mapper translates `AuditError('write_failed', ...)`
 *     into a 500 `internal_error` envelope so the rolled-back-tx
 *     state never leaks raw audit-driver detail to the client.
 *   * The error-mapper emits a high-severity structured Pino-error
 *     event (`audit_write_failed_in_tx`) so the ops alert pipeline
 *     can page on tx-rollback caused by audit-write failure (NIST
 *     SP 800-92, OWASP ASVS V8.6).
 *   * `writeAudit`'s `AuditDatabase` parameter is structurally a
 *     `Pick<CrivacyDatabase, 'insert'>`, so a Drizzle `tx` (passed
 *     to a `db.transaction(async (tx) => {})` callback) satisfies
 *     the type — Pattern A-in-tx wraps compile without forcing a
 *     handler-shaped type assertion.
 */

import { describe, expect, it, vi } from 'vitest';

import { AuditError } from '@/lib/audit/errors';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';

vi.mock('@/lib/observability/logger', () => {
  const error = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();
  const info = vi.fn();
  return {
    getRootLogger: () => ({ error, warn, debug, info }),
    __mocks: { error, warn, debug, info },
  };
});

import * as loggerModule from '@/lib/observability/logger';

const loggerMocks = (loggerModule as unknown as {
  __mocks: {
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
}).__mocks;

describe('error-mapper — AuditError observability hardening', () => {
  it('maps AuditError to a 500 internal_error envelope', () => {
    loggerMocks.error.mockClear();
    const err = new AuditError('write_failed', 'audit insert failed', {
      cause: new Error('deadlock detected'),
      context: { action: 'firm_user.login.failed' },
    });

    const mapped = mapErrorToResponse(err);

    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
    expect(mapped.message).toBe('Internal audit-log error.');
  });

  it('emits a high-severity structured Pino event on AuditError', () => {
    loggerMocks.error.mockClear();
    const err = new AuditError('write_failed', 'audit insert failed', {
      cause: new Error('connection reset by peer'),
      context: { action: 'customer.login.failed' },
    });

    mapErrorToResponse(err);

    expect(loggerMocks.error).toHaveBeenCalledTimes(1);
    const callArgs = loggerMocks.error.mock.calls[0];
    if (callArgs === undefined) {
      throw new Error('expected a logger.error call');
    }
    const [payload, message] = callArgs;
    expect(payload).toMatchObject({
      event: 'audit_write_failed_in_tx',
      code: 'write_failed',
      message: 'audit insert failed',
      context: { action: 'customer.login.failed' },
    });
    expect(payload.cause).toMatchObject({
      name: 'Error',
      message: 'connection reset by peer',
    });
    expect(message).toBe(
      'audit-write failure caused tx rollback — investigate compliance impact',
    );
  });

  it('does not echo audit error message text to the client', () => {
    loggerMocks.error.mockClear();
    const err = new AuditError('write_failed', 'leaky-internal-detail', {
      cause: new Error('row id 42 collision'),
    });

    const mapped = mapErrorToResponse(err);

    // Generic envelope — never contains the raw AuditError message.
    expect(mapped.message).not.toContain('leaky-internal-detail');
    expect(mapped.message).not.toContain('row id 42');
  });

  it('handles AuditError without cause / context cleanly', () => {
    loggerMocks.error.mockClear();
    const err = new AuditError('write_failed', 'insert returned no row');

    const mapped = mapErrorToResponse(err);

    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
    expect(loggerMocks.error).toHaveBeenCalledTimes(1);
    const callArgs = loggerMocks.error.mock.calls[0];
    if (callArgs === undefined) {
      throw new Error('expected a logger.error call');
    }
    const payload = callArgs[0];
    expect(payload.context).toBeUndefined();
    expect(payload.cause).toBeUndefined();
  });

  it('also surfaces validation-class AuditError codes (programmer error)', () => {
    loggerMocks.error.mockClear();
    const err = new AuditError('invalid_action', 'unknown action key');

    const mapped = mapErrorToResponse(err);

    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
    expect(loggerMocks.error).toHaveBeenCalledTimes(1);
    const callArgs = loggerMocks.error.mock.calls[0];
    if (callArgs === undefined) {
      throw new Error('expected a logger.error call');
    }
    const payload = callArgs[0];
    expect(payload.code).toBe('invalid_action');
  });
});
