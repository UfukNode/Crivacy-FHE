/**
 * `CRIVACY_MAINTENANCE_MODE` platform kill-switch tests.
 *
 * Pins the contract the runbook promises:
 *
 *   * Env truthy (`1`, `true`, `yes`, `on`, case-insensitive) flips it on.
 *   * Env missing / empty / anything else leaves it off.
 *   * Memoised — once observed, subsequent reads don't re-check env.
 *   * Exempt paths bypass the gate (admin UI, admin API, health,
 *     status page, static assets).
 *   * Non-exempt paths are gated, even under the admin *name* prefix
 *     (`/adminfoo` is NOT `/admin`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isMaintenanceExempt,
  isMaintenanceMode,
  resetMaintenanceModeForTests,
} from '@/lib/env/maintenance';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env['CRIVACY_MAINTENANCE_MODE'];
  resetMaintenanceModeForTests();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  resetMaintenanceModeForTests();
});

describe('isMaintenanceMode — env parsing', () => {
  it('returns false when the env var is unset', () => {
    expect(isMaintenanceMode()).toBe(false);
  });

  it('returns false when the env var is empty string', () => {
    process.env['CRIVACY_MAINTENANCE_MODE'] = '';
    expect(isMaintenanceMode()).toBe(false);
  });

  it('returns false when the env var is whitespace only', () => {
    process.env['CRIVACY_MAINTENANCE_MODE'] = '   ';
    expect(isMaintenanceMode()).toBe(false);
  });

  it.each(['1', 'true', 'yes', 'on', 'TRUE', 'YES', 'On'])(
    'returns true for truthy value %s',
    (value) => {
      process.env['CRIVACY_MAINTENANCE_MODE'] = value;
      expect(isMaintenanceMode()).toBe(true);
    },
  );

  it.each(['0', 'false', 'no', 'off', 'random', 'disabled', '2'])(
    'returns false for non-matching value %s',
    (value) => {
      process.env['CRIVACY_MAINTENANCE_MODE'] = value;
      expect(isMaintenanceMode()).toBe(false);
    },
  );

  it('memoises the value across calls (env change is ignored until reset)', () => {
    process.env['CRIVACY_MAINTENANCE_MODE'] = '1';
    expect(isMaintenanceMode()).toBe(true);
    delete process.env['CRIVACY_MAINTENANCE_MODE'];
    expect(isMaintenanceMode()).toBe(true);
    resetMaintenanceModeForTests();
    expect(isMaintenanceMode()).toBe(false);
  });
});

describe('isMaintenanceExempt — path matching', () => {
  it.each([
    '/admin',
    '/admin/',
    '/admin/dashboard',
    '/admin/customers/123',
    '/api/internal/admin',
    '/api/internal/admin/firms',
    '/api/v1/health',
    '/api/v1/status',
    '/status',
    '/status/incidents/abc',
    '/_next',
    '/_next/static/chunks/main.js',
    '/assets',
    '/assets/crivacy/v1/crivacy.js',
    '/favicon',
    '/favicon.ico',
  ])('allows exempt path %s through the gate', (pathname) => {
    expect(isMaintenanceExempt(pathname)).toBe(true);
  });

  it.each([
    '/',
    '/login',
    '/register',
    '/dashboard',
    '/dashboard/webhooks',
    '/api/customer/auth/login',
    '/api/internal/auth/login',
    '/api/v1/sessions',
    '/kyc/identity',
    '/settings/security',
  ])('gates non-exempt path %s', (pathname) => {
    expect(isMaintenanceExempt(pathname)).toBe(false);
  });

  it('does NOT let a sibling prefix sneak past the boundary', () => {
    // A route named /adminfoo is NOT exempt just because it starts with /admin
    expect(isMaintenanceExempt('/adminfoo')).toBe(false);
    expect(isMaintenanceExempt('/admin-panel')).toBe(false);
    expect(isMaintenanceExempt('/statusboard')).toBe(false);
    expect(isMaintenanceExempt('/_nexthop')).toBe(false);
  });
});
