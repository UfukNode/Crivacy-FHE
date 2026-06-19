/**
 * Observability error tests.
 */

import { describe, expect, it } from 'vitest';

import {
  OBSERVABILITY_ERROR_CODES,
  ObservabilityError,
  isObservabilityError,
} from '@/lib/observability/errors';

describe('ObservabilityError', () => {
  it('creates error with code and message', () => {
    const err = new ObservabilityError('invalid_config', 'Bad config');
    expect(err.code).toBe('invalid_config');
    expect(err.message).toBe('Bad config');
    expect(err.name).toBe('ObservabilityError');
    expect(err.context).toBeUndefined();
  });

  it('creates error with context', () => {
    const err = new ObservabilityError('unexpected', 'Boom', { key: 'value' });
    expect(err.context).toEqual({ key: 'value' });
  });

  it('freezes the error object', () => {
    const err = new ObservabilityError('unexpected', 'Frozen');
    expect(Object.isFrozen(err)).toBe(true);
  });

  it('freezes context', () => {
    const err = new ObservabilityError('unexpected', 'Test', { a: 1 });
    expect(Object.isFrozen(err.context)).toBe(true);
  });

  it('wrap returns existing ObservabilityError unchanged', () => {
    const original = new ObservabilityError('invalid_config', 'Original');
    const wrapped = ObservabilityError.wrap('unexpected', original);
    expect(wrapped).toBe(original);
    expect(wrapped.code).toBe('invalid_config');
  });

  it('wrap wraps Error', () => {
    const wrapped = ObservabilityError.wrap('unexpected', new Error('Native error'));
    expect(wrapped.code).toBe('unexpected');
    expect(wrapped.message).toBe('Native error');
  });

  it('wrap wraps non-Error', () => {
    const wrapped = ObservabilityError.wrap('unexpected', 'string error');
    expect(wrapped.code).toBe('unexpected');
    expect(wrapped.message).toBe('string error');
  });
});

describe('isObservabilityError', () => {
  it('returns true for ObservabilityError', () => {
    expect(isObservabilityError(new ObservabilityError('unexpected', 'Test'))).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isObservabilityError(new Error('Test'))).toBe(false);
  });

  it('returns false for non-Error', () => {
    expect(isObservabilityError('string')).toBe(false);
    expect(isObservabilityError(null)).toBe(false);
  });
});

describe('OBSERVABILITY_ERROR_CODES', () => {
  it('is a readonly tuple', () => {
    expect(Array.isArray(OBSERVABILITY_ERROR_CODES)).toBe(true);
  });

  it('contains expected codes', () => {
    expect(OBSERVABILITY_ERROR_CODES).toContain('invalid_config');
    expect(OBSERVABILITY_ERROR_CODES).toContain('unexpected');
    expect(OBSERVABILITY_ERROR_CODES).toContain('metrics_registration_failed');
    expect(OBSERVABILITY_ERROR_CODES).toContain('logger_initialization_failed');
    expect(OBSERVABILITY_ERROR_CODES).toContain('tracer_initialization_failed');
  });

  it('has exactly 5 codes', () => {
    expect(OBSERVABILITY_ERROR_CODES.length).toBe(5);
  });
});
