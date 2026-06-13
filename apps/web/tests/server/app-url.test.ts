/**
 * `getAppUrl` boot-time contract tests.
 *
 * Pins the behaviour that closed INFO-27-004 (Cat 27) + the
 * "no hardcoded fallbacks" rule in `CLAUDE.md`:
 *
 *   * Production + env missing/empty → throw.
 *   * Production + env not `https://` → throw.
 *   * Production + env set to `https://...` → trimmed value.
 *   * Dev / test + env missing → returns the local dev default
 *     (so tests that don't care about URL composition keep
 *     working without touching process.env).
 *
 * These cases also ensure migrations from the old
 * `process.env['NEXT_PUBLIC_APP_URL'] ?? 'https://app.crivacy.io'`
 * pattern cannot silently downgrade back to a plain-http fallback.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getAppUrl, resetAppUrlForTests } from '@/lib/env/app-url';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetAppUrlForTests();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  resetAppUrlForTests();
});

describe('getAppUrl — production', () => {
  it('throws when NEXT_PUBLIC_APP_URL is missing in production', () => {
    process.env = { ...process.env, NODE_ENV: 'production' };
    delete process.env['NEXT_PUBLIC_APP_URL'];
    expect(() => getAppUrl()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('throws when NEXT_PUBLIC_APP_URL is empty in production', () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_PUBLIC_APP_URL: '   ',
    };
    expect(() => getAppUrl()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('throws when NEXT_PUBLIC_APP_URL is http:// in production', () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_PUBLIC_APP_URL: 'http://app.crivacy.io',
    };
    expect(() => getAppUrl()).toThrow(/https:\/\//);
  });

  it('returns the trimmed value when NEXT_PUBLIC_APP_URL is valid https:// in production', () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_PUBLIC_APP_URL: 'https://app.crivacy.io',
    };
    expect(getAppUrl()).toBe('https://app.crivacy.io');
  });

  it('strips trailing slashes in production so `${appUrl}/path` concatenation works', () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_PUBLIC_APP_URL: 'https://app.crivacy.io///',
    };
    expect(getAppUrl()).toBe('https://app.crivacy.io');
  });

  it('re-throws the same error on subsequent calls without re-reading env', () => {
    process.env = { ...process.env, NODE_ENV: 'production' };
    delete process.env['NEXT_PUBLIC_APP_URL'];
    expect(() => getAppUrl()).toThrow();
    // Setting the env after the first throw must NOT rescue the cached
    // miss — fail-loud stays loud until the process restarts.
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.crivacy.io';
    expect(() => getAppUrl()).toThrow();
  });
});

describe('getAppUrl — dev / test', () => {
  it('falls back to the local dev default when env is missing in development', () => {
    process.env = { ...process.env, NODE_ENV: 'development' };
    delete process.env['NEXT_PUBLIC_APP_URL'];
    expect(getAppUrl()).toBe('http://localhost:3001');
  });

  it('falls back to the local dev default when env is missing under test', () => {
    process.env = { ...process.env, NODE_ENV: 'test' };
    delete process.env['NEXT_PUBLIC_APP_URL'];
    expect(getAppUrl()).toBe('http://localhost:3001');
  });

  it('honours an explicit http:// override in non-production', () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_PUBLIC_APP_URL: 'http://localhost:4000',
    };
    expect(getAppUrl()).toBe('http://localhost:4000');
  });

  it('memoises the value across calls', () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_PUBLIC_APP_URL: 'http://localhost:4000',
    };
    expect(getAppUrl()).toBe('http://localhost:4000');
    process.env['NEXT_PUBLIC_APP_URL'] = 'http://localhost:5000';
    // Still returns the first-read value — the reset-for-tests helper
    // is the only supported way to pick up an env change.
    expect(getAppUrl()).toBe('http://localhost:4000');
  });
});
