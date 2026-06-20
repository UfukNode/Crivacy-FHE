/**
 * Primitive Zod schema behavior tests. These guarantee the base types
 * that every schema builds on top of enforce the constraints the spec
 * documentation claims. If one of these regresses, the generated spec
 * is still technically valid OpenAPI, but runtime validation becomes
 * looser than documented — which is worse than a hard spec mismatch.
 */

import { describe, expect, it } from 'vitest';

import {
  DateTimeIso,
  DisplayName,
  EmailAddress,
  HttpsUrl,
  PaginationCursor,
  RequestId,
  SafeCount,
  Slug,
  UserRef,
  UuidV4,
} from '@/lib/openapi/common/primitives';

describe('openapi/primitives', () => {
  describe('UuidV4', () => {
    it('accepts canonical v4 ids', () => {
      expect(UuidV4.parse('6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7')).toBe(
        '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
      );
    });
    it('rejects non-uuid strings', () => {
      expect(() => UuidV4.parse('not-a-uuid')).toThrow();
    });
  });

  describe('DateTimeIso', () => {
    it('accepts an ISO-8601 instant with Z suffix', () => {
      expect(DateTimeIso.parse('2026-04-11T10:30:00.000Z')).toBe('2026-04-11T10:30:00.000Z');
    });
    it('rejects a naive date-only string', () => {
      expect(() => DateTimeIso.parse('2026-04-11')).toThrow();
    });
  });

  describe('Slug', () => {
    it('accepts lowercase dashed slugs', () => {
      expect(Slug.parse('acme-bank')).toBe('acme-bank');
    });
    it('rejects uppercase', () => {
      expect(() => Slug.parse('Acme-Bank')).toThrow();
    });
    it('rejects leading/trailing dash', () => {
      expect(() => Slug.parse('-acme')).toThrow();
      expect(() => Slug.parse('acme-')).toThrow();
    });
  });

  describe('DisplayName', () => {
    it('accepts a 1-char name', () => {
      expect(DisplayName.parse('a')).toBe('a');
    });
    it('rejects empty string', () => {
      expect(() => DisplayName.parse('')).toThrow();
    });
  });

  describe('EmailAddress', () => {
    it('accepts a valid email', () => {
      expect(EmailAddress.parse('ops@acme-bank.com')).toBe('ops@acme-bank.com');
    });
    it('rejects a bare domain', () => {
      expect(() => EmailAddress.parse('acme-bank.com')).toThrow();
    });
  });

  describe('HttpsUrl', () => {
    it('accepts https URLs', () => {
      expect(HttpsUrl.parse('https://example.com/hook')).toBe('https://example.com/hook');
    });
    it('rejects http URLs', () => {
      expect(() => HttpsUrl.parse('http://example.com/hook')).toThrow();
    });
    it('rejects arbitrary schemes', () => {
      expect(() => HttpsUrl.parse('javascript:alert(1)')).toThrow();
    });
  });

  describe('UserRef', () => {
    it('accepts a 1-char ref', () => {
      expect(UserRef.parse('u1')).toBe('u1');
    });
    it('rejects empty string', () => {
      expect(() => UserRef.parse('')).toThrow();
    });
  });

  describe('PaginationCursor', () => {
    it('accepts url-safe base64 cursor', () => {
      expect(PaginationCursor.parse('YWJjZGVm_0123-45')).toBe('YWJjZGVm_0123-45');
    });
    it('rejects padding characters', () => {
      expect(() => PaginationCursor.parse('abc==')).toThrow();
    });
  });

  describe('SafeCount', () => {
    it('accepts zero', () => {
      expect(SafeCount.parse(0)).toBe(0);
    });
    it('rejects negative values', () => {
      expect(() => SafeCount.parse(-1)).toThrow();
    });
    it('rejects non-integer values', () => {
      expect(() => SafeCount.parse(1.5)).toThrow();
    });
  });

  describe('RequestId', () => {
    it('accepts a v4 uuid', () => {
      expect(RequestId.parse('6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7')).toBe(
        '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
      );
    });
  });
});
