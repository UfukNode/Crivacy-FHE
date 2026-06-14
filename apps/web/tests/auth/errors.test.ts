// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { AuthError, isAuthError, isAuthErrorWithCode } from '@/lib/auth';

describe('auth/errors', () => {
  it('constructs with the given code and message', () => {
    const err = new AuthError('invalid_api_key', 'bad prefix');
    expect(err.code).toBe('invalid_api_key');
    expect(err.message).toBe('bad prefix');
    expect(err.name).toBe('AuthError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AuthError);
  });

  it('preserves cause through the options argument', () => {
    const cause = new Error('underlying bcrypt failure');
    const err = new AuthError('unsupported_api_key_hash', 'wrap', { cause });
    expect((err as Error & { cause?: unknown }).cause).toBe(cause);
  });

  it('captures a stack trace', () => {
    const err = new AuthError('invalid_jwt', 'no stack?');
    expect(typeof err.stack).toBe('string');
    expect((err.stack as string).length).toBeGreaterThan(0);
  });

  describe('isAuthError', () => {
    it('narrows on AuthError instances', () => {
      const raw: unknown = new AuthError('expired_jwt', 'past');
      if (isAuthError(raw)) {
        // TypeScript narrowing check — accessing .code must compile.
        expect(raw.code).toBe('expired_jwt');
      } else {
        throw new Error('should narrow');
      }
    });

    it('rejects plain errors and non-errors', () => {
      expect(isAuthError(new Error('plain'))).toBe(false);
      expect(isAuthError('string')).toBe(false);
      expect(isAuthError(null)).toBe(false);
      expect(isAuthError(undefined)).toBe(false);
      expect(isAuthError({ code: 'invalid_jwt' })).toBe(false);
    });
  });

  describe('isAuthErrorWithCode', () => {
    it('matches when the code is listed', () => {
      const err = new AuthError('invalid_totp_code', 'nope');
      expect(isAuthErrorWithCode(err, 'invalid_totp_code', 'invalid_jwt')).toBe(true);
    });

    it('rejects when the code is not listed', () => {
      const err = new AuthError('invalid_totp_code', 'nope');
      expect(isAuthErrorWithCode(err, 'invalid_jwt', 'expired_jwt')).toBe(false);
    });

    it('rejects non-AuthError values', () => {
      expect(isAuthErrorWithCode(new Error('plain'), 'invalid_jwt')).toBe(false);
    });
  });
});
