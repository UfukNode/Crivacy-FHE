import { describe, expect, it } from 'vitest';

import { sanitizeSameOriginPath } from '@/lib/security/safe-redirect';

describe('sanitizeSameOriginPath', () => {
  const ORIGIN = 'https://app.crivacy.io';

  describe('accepts same-origin paths', () => {
    it('plain path', () => {
      expect(sanitizeSameOriginPath('/dashboard', ORIGIN)).toBe('/dashboard');
    });
    it('nested path', () => {
      expect(sanitizeSameOriginPath('/dashboard/api-keys', ORIGIN)).toBe('/dashboard/api-keys');
    });
    it('preserves query string', () => {
      expect(sanitizeSameOriginPath('/dashboard?tab=keys', ORIGIN)).toBe('/dashboard?tab=keys');
    });
    it('preserves hash', () => {
      expect(sanitizeSameOriginPath('/dashboard#section', ORIGIN)).toBe('/dashboard#section');
    });
    it('preserves query + hash together', () => {
      expect(sanitizeSameOriginPath('/a?b=1#c', ORIGIN)).toBe('/a?b=1#c');
    });
    it('userinfo @ in path is a literal path segment, same-origin', () => {
      expect(sanitizeSameOriginPath('/@evil.com/x', ORIGIN)).toBe('/@evil.com/x');
    });
    it('percent-encoded %2F%2F is a literal path, same-origin', () => {
      // Browsers don't re-decode %2F in path segments. The path stays
      // on our origin — attacker gains nothing.
      expect(sanitizeSameOriginPath('/%2F%2Fevil.com', ORIGIN)).toBe('/%2F%2Fevil.com');
    });
  });

  describe('attacker patterns — rejected outright', () => {
    it('protocol-relative //evil', () => {
      expect(sanitizeSameOriginPath('//evil.com/x', ORIGIN)).toBe('/');
    });
    it('backslash prefix /\\evil', () => {
      expect(sanitizeSameOriginPath('/\\evil.com/x', ORIGIN)).toBe('/');
    });
    it('absolute URL with https:', () => {
      expect(sanitizeSameOriginPath('https://evil.com/x', ORIGIN)).toBe('/');
    });
    it('absolute URL with http:', () => {
      expect(sanitizeSameOriginPath('http://evil.com', ORIGIN)).toBe('/');
    });
    it('javascript: URI', () => {
      expect(sanitizeSameOriginPath('javascript:alert(1)', ORIGIN)).toBe('/');
    });
    it('data: URI', () => {
      expect(sanitizeSameOriginPath('data:text/html,<script>alert(1)</script>', ORIGIN)).toBe('/');
    });
    it('empty string', () => {
      expect(sanitizeSameOriginPath('', ORIGIN)).toBe('/');
    });
    it('whitespace-only', () => {
      expect(sanitizeSameOriginPath('   ', ORIGIN)).toBe('/');
    });
    it('null', () => {
      expect(sanitizeSameOriginPath(null, ORIGIN)).toBe('/');
    });
    it('undefined', () => {
      expect(sanitizeSameOriginPath(undefined, ORIGIN)).toBe('/');
    });
    it('non-string values', () => {
      expect(sanitizeSameOriginPath(42, ORIGIN)).toBe('/');
      expect(sanitizeSameOriginPath({}, ORIGIN)).toBe('/');
      expect(sanitizeSameOriginPath([], ORIGIN)).toBe('/');
    });
    it('no leading slash', () => {
      expect(sanitizeSameOriginPath('dashboard', ORIGIN)).toBe('/');
    });
  });

  describe('control-char normalization (matches browser parser)', () => {
    // Browsers silently strip tab/newline/CR from URLs. Helper
    // mirrors that: `/\tevil.com/x` → `/evil.com/x` = same-origin
    // path (404 on our server, not phishing redirect to evil.com).
    it('tab-prefix normalized to same-origin path', () => {
      expect(sanitizeSameOriginPath('/\tevil.com/x', ORIGIN)).toBe('/evil.com/x');
    });
    it('newline-prefix normalized to same-origin path', () => {
      expect(sanitizeSameOriginPath('/\nevil.com/x', ORIGIN)).toBe('/evil.com/x');
    });
    it('CR-prefix normalized to same-origin path', () => {
      expect(sanitizeSameOriginPath('/\revil.com/x', ORIGIN)).toBe('/evil.com/x');
    });
    it('null-byte normalized to same-origin path', () => {
      expect(sanitizeSameOriginPath('/\0evil', ORIGIN)).toBe('/evil');
    });

    // Attacker-intent variant — control char BETWEEN slashes smuggles
    // `//` past the protocol-relative check. After strip, `/\t/evil`
    // becomes `//evil` which IS protocol-relative → reject.
    it('tab between slashes → post-strip // → rejected', () => {
      expect(sanitizeSameOriginPath('/\t/evil.com', ORIGIN)).toBe('/');
    });
    it('CR between slashes → post-strip // → rejected', () => {
      expect(sanitizeSameOriginPath('/\r/evil.com', ORIGIN)).toBe('/');
    });
  });

  describe('custom fallback', () => {
    it('returns fallback for rejected input', () => {
      expect(sanitizeSameOriginPath('//evil.com', ORIGIN, '/home')).toBe('/home');
    });
    it('returns fallback for non-string', () => {
      expect(sanitizeSameOriginPath(null, ORIGIN, '/home')).toBe('/home');
    });
    it('accepted input ignores fallback', () => {
      expect(sanitizeSameOriginPath('/dashboard', ORIGIN, '/home')).toBe('/dashboard');
    });
  });

  describe('default origin placeholder', () => {
    it('no origin argument uses safe placeholder default', () => {
      expect(sanitizeSameOriginPath('/dashboard')).toBe('/dashboard');
      expect(sanitizeSameOriginPath('//evil')).toBe('/');
    });
  });
});
