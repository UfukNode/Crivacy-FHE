/**
 * Tests for the Didit client error taxonomy. Mirrors the Chain
 * error test shape — we pin the `name` field, the full code union,
 * cause + context preservation, and the idempotent `wrap` helper.
 */

import { describe, expect, it } from 'vitest';

import { DiditError, isDiditError, isDiditErrorWithCode } from '@crivacy-fhe/adapter-didit';
import type { DiditErrorCode } from '@crivacy-fhe/adapter-didit';

/**
 * Exhaustive tuple of every code currently in the union. A new code
 * added without being listed here fails the compile-time exhaustive
 * check below.
 */
const ALL_CODES = [
  'invalid_config',
  'invalid_session_id',
  'invalid_workflow_id',
  'invalid_vendor_data',
  'invalid_callback_url',
  'invalid_full_name',
  'missing_signature',
  'missing_timestamp',
  'stale_signature',
  'invalid_signature',
  'timestamp_mismatch',
  'invalid_webhook_body',
  'request_timeout',
  'network_error',
  'http_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'service_unavailable',
  'invalid_response',
  'empty_response',
  'session_expired',
  'session_declined',
  'decision_pending',
  'unknown_status',
  'unknown_workflow',
  'invalid_proof_input',
  'unexpected',
] as const satisfies readonly DiditErrorCode[];

type _AssertExhaustive =
  Exclude<DiditErrorCode, (typeof ALL_CODES)[number]> extends never ? true : never;
const _exhaustive: _AssertExhaustive = true;
void _exhaustive;

describe('DiditError', () => {
  it('sets the name to DiditError', () => {
    const err = new DiditError('invalid_config', 'bad');
    expect(err.name).toBe('DiditError');
  });

  it('assigns the code verbatim', () => {
    const err = new DiditError('invalid_signature', 'hmac mismatch');
    expect(err.code).toBe('invalid_signature');
  });

  it('preserves the original message', () => {
    const err = new DiditError('invalid_vendor_data', 'vendor_data empty');
    expect(err.message).toBe('vendor_data empty');
  });

  it('is an instance of Error and DiditError', () => {
    const err = new DiditError('invalid_response', 'body failed zod');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DiditError);
  });

  it('has a readable stack trace that names DiditError', () => {
    const err = new DiditError('network_error', 'fetch failed');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('DiditError');
  });

  it('preserves the cause when provided (ES2022 Error.cause)', () => {
    const inner = new Error('socket hang up');
    const err = new DiditError('network_error', 'transport failed', { cause: inner });
    expect((err as unknown as { cause: Error }).cause).toBe(inner);
  });

  it('does not set cause when omitted', () => {
    const err = new DiditError('empty_response', '2xx empty body');
    expect((err as unknown as { cause?: unknown }).cause).toBeUndefined();
  });

  it('preserves context when provided', () => {
    const err = new DiditError('http_error', 'upstream 418', {
      context: { status: 418, path: '/v3/session/' },
    });
    expect(err.context).toEqual({ status: 418, path: '/v3/session/' });
  });

  it('omits context when not provided', () => {
    const err = new DiditError('unauthorized', 'api key rejected');
    expect(err.context).toBeUndefined();
  });

  it('accepts arbitrary non-Error causes without coercion', () => {
    const cause = { statusCode: 503 };
    const err = new DiditError('service_unavailable', '5xx', { cause });
    expect((err as unknown as { cause: unknown }).cause).toBe(cause);
  });

  it('constructs every code in the DiditErrorCode union', () => {
    for (const code of ALL_CODES) {
      const err = new DiditError(code, `message for ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`message for ${code}`);
      expect(err.name).toBe('DiditError');
    }
  });

  it('keeps instanceof working after throw/catch', () => {
    let caught: unknown;
    try {
      throw new DiditError('decision_pending', 'still in progress');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DiditError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as DiditError).code).toBe('decision_pending');
  });
});

describe('DiditError.wrap', () => {
  it('wraps an arbitrary Error into a DiditError with the given code', () => {
    const inner = new Error('DNS lookup failed');
    const wrapped = DiditError.wrap('network_error', 'failed to reach didit', inner);
    expect(wrapped).toBeInstanceOf(DiditError);
    expect(wrapped.code).toBe('network_error');
    expect(wrapped.message).toBe('failed to reach didit');
    expect((wrapped as unknown as { cause: Error }).cause).toBe(inner);
  });

  it('wraps non-Error primitive values', () => {
    const wrapped = DiditError.wrap('unexpected', 'bad', 'string cause');
    expect((wrapped as unknown as { cause: unknown }).cause).toBe('string cause');
  });

  it('wraps null and undefined as cause without throwing', () => {
    expect(DiditError.wrap('unexpected', 'a', null)).toBeInstanceOf(DiditError);
    expect(DiditError.wrap('unexpected', 'b', undefined)).toBeInstanceOf(DiditError);
  });

  it('threads context through on wrap', () => {
    const wrapped = DiditError.wrap('invalid_response', 'bad body', new Error('x'), {
      sessionId: 'sess-1',
    });
    expect(wrapped.context).toEqual({ sessionId: 'sess-1' });
  });

  it('omits context when not passed', () => {
    const wrapped = DiditError.wrap('unexpected', 'boom', new Error('x'));
    expect(wrapped.context).toBeUndefined();
  });

  it('is idempotent — wrapping a DiditError returns the original', () => {
    const original = new DiditError('invalid_signature', 'original');
    const wrapped = DiditError.wrap('unexpected', 'secondary', original);
    expect(wrapped).toBe(original);
    expect(wrapped.code).toBe('invalid_signature');
    expect(wrapped.message).toBe('original');
  });

  it('is idempotent even when context is passed alongside a DiditError cause', () => {
    const original = new DiditError('invalid_vendor_data', 'bad');
    const wrapped = DiditError.wrap('unexpected', 'outer', original, { extra: 1 });
    expect(wrapped).toBe(original);
    expect(wrapped.context).toBeUndefined();
  });
});

describe('isDiditError', () => {
  it('returns true for DiditError instances', () => {
    expect(isDiditError(new DiditError('invalid_config', 'bad'))).toBe(true);
  });

  it('returns false for plain Error instances', () => {
    expect(isDiditError(new Error('plain'))).toBe(false);
  });

  it('returns false for error-shaped plain objects', () => {
    expect(isDiditError({ name: 'DiditError', code: 'invalid_config', message: 'x' })).toBe(false);
  });

  it('returns false for non-error primitives', () => {
    expect(isDiditError(undefined)).toBe(false);
    expect(isDiditError(null)).toBe(false);
    expect(isDiditError('DiditError')).toBe(false);
    expect(isDiditError(42)).toBe(false);
    expect(isDiditError([])).toBe(false);
  });
});

describe('isDiditErrorWithCode', () => {
  it('narrows to the requested code when it matches', () => {
    const err: unknown = new DiditError('not_found', 'missing');
    if (isDiditErrorWithCode(err, 'not_found')) {
      expect(err.code).toBe('not_found');
    } else {
      throw new Error('expected narrowing to succeed');
    }
  });

  it('returns true when any of several codes match', () => {
    const err = new DiditError('forbidden', 'denied');
    expect(isDiditErrorWithCode(err, 'not_found', 'forbidden')).toBe(true);
  });

  it('returns false when no codes match', () => {
    const err = new DiditError('forbidden', 'denied');
    expect(isDiditErrorWithCode(err, 'not_found', 'unauthorized')).toBe(false);
  });

  it('returns false for plain Error instances', () => {
    expect(isDiditErrorWithCode(new Error('plain'), 'not_found')).toBe(false);
  });

  it('returns false for error-shaped plain objects', () => {
    expect(isDiditErrorWithCode({ name: 'DiditError', code: 'not_found' }, 'not_found')).toBe(
      false,
    );
  });

  it('returns false for non-error values', () => {
    expect(isDiditErrorWithCode(null, 'not_found')).toBe(false);
    expect(isDiditErrorWithCode(undefined, 'not_found')).toBe(false);
    expect(isDiditErrorWithCode('not_found', 'not_found')).toBe(false);
  });

  it('returns false when called with zero code arguments', () => {
    const err = new DiditError('invalid_response', 'x');
    expect(isDiditErrorWithCode(err)).toBe(false);
  });
});
