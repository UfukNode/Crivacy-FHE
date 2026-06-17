/**
 * Tests for webhook error hierarchy.
 */

import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_ERROR_CODES,
  WebhookError,
  isWebhookError,
  isWebhookErrorWithCode,
} from '@/lib/webhook';

describe('WebhookError', () => {
  it('constructs with code and message', () => {
    const err = new WebhookError('delivery_failed', 'timeout');
    expect(err.code).toBe('delivery_failed');
    expect(err.message).toBe('timeout');
    expect(err.name).toBe('WebhookError');
    expect(err).toBeInstanceOf(Error);
  });

  it('carries context', () => {
    const err = new WebhookError('invalid_config', 'bad', {
      context: { field: 'timeout' },
    });
    expect(err.context).toEqual({ field: 'timeout' });
  });

  it('carries cause', () => {
    const cause = new Error('original');
    const err = new WebhookError('unexpected', 'wrapped', { cause });
    expect(err.cause).toBe(cause);
  });

  it('omits context when not provided', () => {
    const err = new WebhookError('delivery_failed', 'no ctx');
    expect(err.context).toBeUndefined();
  });
});

describe('WebhookError.wrap', () => {
  it('returns the same error if already a WebhookError', () => {
    const original = new WebhookError('delivery_failed', 'already');
    const wrapped = WebhookError.wrap('unexpected', original);
    expect(wrapped).toBe(original);
  });

  it('wraps a plain Error', () => {
    const original = new Error('plain');
    const wrapped = WebhookError.wrap('queue_error', original);
    expect(wrapped.code).toBe('queue_error');
    expect(wrapped.message).toBe('plain');
    expect(wrapped.cause).toBe(original);
  });

  it('wraps a string', () => {
    const wrapped = WebhookError.wrap('unexpected', 'something failed');
    expect(wrapped.message).toBe('something failed');
  });

  it('carries context', () => {
    const wrapped = WebhookError.wrap('fan_out_failed', 'oops', { eventId: '123' });
    expect(wrapped.context).toEqual({ eventId: '123' });
  });
});

describe('isWebhookError', () => {
  it('returns true for WebhookError', () => {
    expect(isWebhookError(new WebhookError('unexpected', 'x'))).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isWebhookError(new Error('x'))).toBe(false);
  });

  it('returns false for non-errors', () => {
    expect(isWebhookError('string')).toBe(false);
    expect(isWebhookError(null)).toBe(false);
  });
});

describe('isWebhookErrorWithCode', () => {
  it('returns true for matching code', () => {
    const err = new WebhookError('delivery_timeout', 'slow');
    expect(isWebhookErrorWithCode(err, 'delivery_timeout')).toBe(true);
  });

  it('returns false for non-matching code', () => {
    const err = new WebhookError('delivery_timeout', 'slow');
    expect(isWebhookErrorWithCode(err, 'queue_error')).toBe(false);
  });
});

describe('WEBHOOK_ERROR_CODES', () => {
  it('is a frozen tuple of known codes', () => {
    expect(WEBHOOK_ERROR_CODES.length).toBeGreaterThan(10);
    expect(WEBHOOK_ERROR_CODES).toContain('delivery_failed');
    expect(WEBHOOK_ERROR_CODES).toContain('circuit_breaker_open');
    expect(WEBHOOK_ERROR_CODES).toContain('queue_error');
  });
});
