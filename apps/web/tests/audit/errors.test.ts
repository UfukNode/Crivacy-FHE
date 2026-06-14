/**
 * Tests for the audit error taxonomy.
 *
 * `AuditError` is a small class but it is load-bearing for the route
 * layer: the error code drives the HTTP status mapping and the log
 * line shape. These tests pin the invariants that callers rely on:
 *
 *   * `name` is stable (`'AuditError'`) so `err.name === 'AuditError'`
 *     works across module boundaries.
 *   * `code` is assigned from the constructor argument.
 *   * `cause` is preserved when provided.
 *   * `context` is preserved when provided and omitted otherwise.
 *   * `wrap` is idempotent — wrapping an `AuditError` returns the
 *     original so the first writer in the chain wins.
 *   * `isAuditError` correctly distinguishes `AuditError` from
 *     arbitrary `Error` values.
 */

import { describe, expect, it } from 'vitest';

import { AuditError, isAuditError } from '@/lib/audit';

describe('AuditError', () => {
  it('sets the name to AuditError', () => {
    const err = new AuditError('invalid_actor', 'bad');
    expect(err.name).toBe('AuditError');
  });

  it('assigns the code verbatim', () => {
    const err = new AuditError('meta_too_large', 'big');
    expect(err.code).toBe('meta_too_large');
  });

  it('preserves the original message', () => {
    const err = new AuditError('invalid_target', 'target.kind is not a known audit_target_kind');
    expect(err.message).toBe('target.kind is not a known audit_target_kind');
  });

  it('preserves the cause when provided', () => {
    const inner = new Error('driver fell over');
    const err = new AuditError('write_failed', 'insert failed', { cause: inner });
    expect((err as unknown as { cause: Error }).cause).toBe(inner);
  });

  it('does not set cause when omitted', () => {
    const err = new AuditError('invalid_meta', 'bad');
    expect((err as unknown as { cause?: unknown }).cause).toBeUndefined();
  });

  it('preserves the context when provided', () => {
    const err = new AuditError('invalid_action', 'bad', {
      context: { received: 'firm_user.nuked' },
    });
    expect(err.context).toEqual({ received: 'firm_user.nuked' });
  });

  it('omits context when not provided', () => {
    const err = new AuditError('batch_empty', 'empty');
    expect(err.context).toBeUndefined();
  });

  it('is an instance of Error', () => {
    const err = new AuditError('invalid_context', 'bad');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AuditError).toBe(true);
  });

  it('has a readable stack trace', () => {
    const err = new AuditError('read_failed', 'query failed');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('AuditError');
  });
});

describe('AuditError.wrap', () => {
  it('wraps an arbitrary Error into an AuditError with the given code', () => {
    const inner = new Error('connection reset');
    const wrapped = AuditError.wrap('write_failed', 'insert failed', inner);
    expect(wrapped).toBeInstanceOf(AuditError);
    expect(wrapped.code).toBe('write_failed');
    expect(wrapped.message).toBe('insert failed');
    expect((wrapped as unknown as { cause: Error }).cause).toBe(inner);
  });

  it('wraps non-Error values too', () => {
    const wrapped = AuditError.wrap('invalid_meta', 'bad', 'string cause');
    expect((wrapped as unknown as { cause: unknown }).cause).toBe('string cause');
  });

  it('is idempotent — wrapping an AuditError returns the original', () => {
    const original = new AuditError('invalid_target', 'original message');
    const wrapped = AuditError.wrap('write_failed', 'secondary message', original);
    expect(wrapped).toBe(original);
    expect(wrapped.code).toBe('invalid_target');
    expect(wrapped.message).toBe('original message');
  });

  it('threads context through on wrap', () => {
    const inner = new Error('boom');
    const wrapped = AuditError.wrap('write_failed', 'insert failed', inner, { action: 'x' });
    expect(wrapped.context).toEqual({ action: 'x' });
  });
});

describe('isAuditError', () => {
  it('returns true for AuditError instances', () => {
    expect(isAuditError(new AuditError('invalid_meta', 'bad'))).toBe(true);
  });

  it('returns false for plain Error instances', () => {
    expect(isAuditError(new Error('plain'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isAuditError(undefined)).toBe(false);
    expect(isAuditError(null)).toBe(false);
    expect(isAuditError('AuditError')).toBe(false);
    expect(isAuditError({ name: 'AuditError', code: 'invalid_meta' })).toBe(false);
    expect(isAuditError(42)).toBe(false);
  });
});
