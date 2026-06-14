/**
 * Tests for the error mapper.
 *
 * Verifies every library error class → `MappedError` translation:
 *
 *   * AuthError codes → correct ApiErrorCode + HTTP status
 *   * ChainError → 502 for transport, 500 for config
 *   * DiditError → 401 for signatures, 502 for transport, 400 for body
 *   * RateLimitError → 500 (internal leak, never reaches client normally)
 *   * ZodError → 400 with field-level issues
 *   * Unknown → 500 internal_error
 *   * Result is always frozen
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AuthError } from '@/lib/auth/errors';
import { DiditError } from '@crivacy-fhe/adapter-didit/errors';
import { RateLimitError } from '@/lib/ratelimit/errors';

import { isMappedError, mapErrorToResponse } from '@/server/middleware/error-mapper';

/* ================================================================== */
/*  AuthError                                                          */
/* ================================================================== */

describe('mapErrorToResponse — AuthError', () => {
  it('maps invalid_api_key to 401', () => {
    const mapped = mapErrorToResponse(new AuthError('invalid_api_key', 'Bad key'));
    expect(mapped.code).toBe('invalid_api_key');
    expect(mapped.status).toBe(401);
  });

  it('maps api_key_mismatch to 401 invalid_api_key', () => {
    const mapped = mapErrorToResponse(new AuthError('api_key_mismatch', 'No match'));
    expect(mapped.code).toBe('invalid_api_key');
    expect(mapped.status).toBe(401);
  });

  it('maps expired_api_key to 401', () => {
    const mapped = mapErrorToResponse(new AuthError('expired_api_key', 'Expired'));
    expect(mapped.code).toBe('expired_api_key');
    expect(mapped.status).toBe(401);
  });

  it('maps revoked_api_key to 401 invalid_api_key', () => {
    const mapped = mapErrorToResponse(new AuthError('revoked_api_key', 'Revoked'));
    expect(mapped.code).toBe('invalid_api_key');
    expect(mapped.status).toBe(401);
  });

  it('maps malformed_jwt to 401 invalid_session', () => {
    const mapped = mapErrorToResponse(new AuthError('malformed_jwt', 'Bad JWT'));
    expect(mapped.code).toBe('invalid_session');
    expect(mapped.status).toBe(401);
  });

  it('maps expired_jwt to 401 invalid_session', () => {
    const mapped = mapErrorToResponse(new AuthError('expired_jwt', 'Expired JWT'));
    expect(mapped.code).toBe('invalid_session');
    expect(mapped.status).toBe(401);
  });

  it('maps invalid_totp_code to 401 totp_invalid', () => {
    const mapped = mapErrorToResponse(new AuthError('invalid_totp_code', 'Bad code'));
    expect(mapped.code).toBe('totp_invalid');
    expect(mapped.status).toBe(401);
  });

  it('maps totp_not_enrolled to 401 totp_required', () => {
    const mapped = mapErrorToResponse(new AuthError('totp_not_enrolled', 'No TOTP'));
    expect(mapped.code).toBe('totp_required');
    expect(mapped.status).toBe(401);
  });

  it('maps unknown_scope to 403 scope_forbidden', () => {
    const mapped = mapErrorToResponse(new AuthError('unknown_scope', 'Bad scope'));
    expect(mapped.code).toBe('scope_forbidden');
    expect(mapped.status).toBe(403);
  });

  it('maps weak_password to 400 validation_failed', () => {
    const mapped = mapErrorToResponse(new AuthError('weak_password', 'Too weak'));
    expect(mapped.code).toBe('validation_failed');
    expect(mapped.status).toBe(400);
  });

  it('maps invalid_password to 401 unauthenticated', () => {
    const mapped = mapErrorToResponse(new AuthError('invalid_password', 'Wrong pass'));
    expect(mapped.code).toBe('unauthenticated');
    expect(mapped.status).toBe(401);
  });

  it('maps config errors to 500 internal_error', () => {
    const mapped = mapErrorToResponse(new AuthError('auth_config_invalid', 'Bad config'));
    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
  });

  it('masks 500 error messages', () => {
    const mapped = mapErrorToResponse(
      new AuthError('unsupported_api_key_hash', 'argon2id not supported'),
    );
    expect(mapped.status).toBe(500);
    expect(mapped.message).not.toContain('argon2id');
    expect(mapped.message).toBe('Internal authentication error.');
  });

  it('preserves the original message for non-500 errors', () => {
    const mapped = mapErrorToResponse(new AuthError('invalid_api_key', 'The key is malformed.'));
    expect(mapped.status).toBe(401);
    expect(mapped.message).toBe('The key is malformed.');
  });
});

/* ================================================================== */
/*  DiditError                                                         */
/* ================================================================== */

describe('mapErrorToResponse — DiditError', () => {
  it('maps signature errors to 401 webhook_signature_invalid', () => {
    for (const code of [
      'missing_signature',
      'missing_timestamp',
      'stale_signature',
      'invalid_signature',
    ] as const) {
      const mapped = mapErrorToResponse(new DiditError(code, 'fail'));
      expect(mapped.code).toBe('webhook_signature_invalid');
      expect(mapped.status).toBe(401);
    }
  });

  it('maps transport errors to 502 didit_unavailable', () => {
    for (const code of [
      'request_timeout',
      'network_error',
      'http_error',
      'service_unavailable',
      'rate_limited',
    ] as const) {
      const mapped = mapErrorToResponse(new DiditError(code, 'fail'));
      expect(mapped.code).toBe('didit_unavailable');
      expect(mapped.status).toBe(502);
    }
  });

  it('maps invalid_webhook_body to 400 validation_failed', () => {
    const mapped = mapErrorToResponse(
      new DiditError('invalid_webhook_body', 'Bad body', {
        context: { issues: [{ path: 'session_id', message: 'required' }] },
      }),
    );
    expect(mapped.code).toBe('validation_failed');
    expect(mapped.status).toBe(400);
  });

  it('carries context as details for invalid_webhook_body', () => {
    const ctx = { issues: [{ path: 'status', message: 'unknown' }] };
    const mapped = mapErrorToResponse(
      new DiditError('invalid_webhook_body', 'fail', { context: ctx }),
    );
    expect(mapped.details).toEqual(ctx);
  });

  it('maps config errors to 500 internal_error', () => {
    const mapped = mapErrorToResponse(new DiditError('invalid_config', 'Bad config'));
    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
  });
});

/* ================================================================== */
/*  RateLimitError                                                     */
/* ================================================================== */

describe('mapErrorToResponse — RateLimitError', () => {
  it('maps to 500 internal_error (should never reach client)', () => {
    const mapped = mapErrorToResponse(new RateLimitError('bucket_row_missing', 'Gone'));
    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
  });

  it('carries details from the error', () => {
    const mapped = mapErrorToResponse(
      new RateLimitError('bucket_row_malformed', 'Bad row', {
        details: { keyId: 'k_123' },
      }),
    );
    expect(mapped.details).toEqual({ keyId: 'k_123' });
  });
});

/* ================================================================== */
/*  ZodError                                                           */
/* ================================================================== */

describe('mapErrorToResponse — ZodError', () => {
  it('maps to 400 validation_failed with field-level issues', () => {
    const schema = z.object({
      email: z.string().email(),
      age: z.number().int().min(0),
    });
    const result = schema.safeParse({ email: 'bad', age: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const mapped = mapErrorToResponse(result.error);
      expect(mapped.code).toBe('validation_failed');
      expect(mapped.status).toBe(400);
      expect(mapped.message).toBe('Request body does not match the expected schema.');
      expect(mapped.details).toBeDefined();
      const issues = (mapped.details as { issues: { path: string; code: string }[] }).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
      expect(issues[0]?.path).toBe('email');
    }
  });

  it('joins nested path segments with dots', () => {
    const schema = z.object({
      metadata: z.object({ key: z.string() }),
    });
    const result = schema.safeParse({ metadata: { key: 123 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const mapped = mapErrorToResponse(result.error);
      const issues = (mapped.details as { issues: { path: string }[] }).issues;
      expect(issues[0]?.path).toBe('metadata.key');
    }
  });
});

/* ================================================================== */
/*  Unknown errors                                                     */
/* ================================================================== */

describe('mapErrorToResponse — unknown', () => {
  it('maps a plain Error to 500 internal_error', () => {
    const mapped = mapErrorToResponse(new Error('oops'));
    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
    expect(mapped.message).toBe('An unexpected error occurred.');
  });

  it('maps a string to 500 internal_error', () => {
    const mapped = mapErrorToResponse('something went wrong');
    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
  });

  it('maps null to 500 internal_error', () => {
    const mapped = mapErrorToResponse(null);
    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
  });

  it('maps undefined to 500 internal_error', () => {
    const mapped = mapErrorToResponse(undefined);
    expect(mapped.code).toBe('internal_error');
    expect(mapped.status).toBe(500);
  });
});

/* ================================================================== */
/*  General contracts                                                  */
/* ================================================================== */

describe('mapErrorToResponse — contracts', () => {
  it('always returns a frozen object', () => {
    expect(Object.isFrozen(mapErrorToResponse(new Error('x')))).toBe(true);
    expect(Object.isFrozen(mapErrorToResponse(new AuthError('invalid_api_key', 'x')))).toBe(true);
  });
});

/* ================================================================== */
/*  isMappedError                                                      */
/* ================================================================== */

describe('isMappedError', () => {
  it('returns true for a valid MappedError', () => {
    expect(isMappedError(mapErrorToResponse(new Error('x')))).toBe(true);
  });

  it('returns false for a plain object missing code', () => {
    expect(isMappedError({ message: 'x', status: 500 })).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isMappedError('not an error')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isMappedError(null)).toBe(false);
  });
});
