/**
 * Database connection resolution + production RLS fail-fast (AUDIT C-2).
 *
 * `resolveDatabaseConnections` decides the admin/app connection strings
 * and, in production, refuses to start when the NOBYPASSRLS app pool
 * would silently fall back to (or duplicate) the BYPASSRLS admin
 * connection. That fallback disables Row-Level Security and breaks
 * cross-tenant isolation, so it must throw at boot rather than serve
 * traffic with RLS off.
 */

import { describe, expect, it } from 'vitest';

import { resolveDatabaseConnections } from '@/lib/db/client';

const ADMIN = 'postgresql://crivacy_admin:pw@127.0.0.1:5433/crivacy';
const APP = 'postgresql://crivacy_app:pw@127.0.0.1:5433/crivacy';

describe('resolveDatabaseConnections', () => {
  describe('admin connection resolution', () => {
    it('prefers DATABASE_URL_ADMIN over DATABASE_URL', () => {
      const r = resolveDatabaseConnections({
        DATABASE_URL_ADMIN: ADMIN,
        DATABASE_URL: 'postgresql://other/db',
        DATABASE_URL_APP: APP,
        NODE_ENV: 'development',
      });
      expect(r.adminConnectionString).toBe(ADMIN);
    });

    it('falls back to DATABASE_URL when DATABASE_URL_ADMIN is unset', () => {
      const r = resolveDatabaseConnections({
        DATABASE_URL: ADMIN,
        NODE_ENV: 'development',
      });
      expect(r.adminConnectionString).toBe(ADMIN);
    });

    it('treats empty strings as unset', () => {
      const r = resolveDatabaseConnections({
        DATABASE_URL_ADMIN: '',
        DATABASE_URL: ADMIN,
        NODE_ENV: 'development',
      });
      expect(r.adminConnectionString).toBe(ADMIN);
    });

    it('throws when no admin connection is configured at all', () => {
      expect(() => resolveDatabaseConnections({ NODE_ENV: 'development' })).toThrow(
        /admin database connection/i,
      );
    });
  });

  describe('production RLS fail-fast', () => {
    it('throws when DATABASE_URL_APP is missing in production', () => {
      expect(() =>
        resolveDatabaseConnections({ DATABASE_URL_ADMIN: ADMIN, NODE_ENV: 'production' }),
      ).toThrow(/DATABASE_URL_APP must be set in production/i);
    });

    it('throws when DATABASE_URL_APP is an empty string in production', () => {
      expect(() =>
        resolveDatabaseConnections({
          DATABASE_URL_ADMIN: ADMIN,
          DATABASE_URL_APP: '',
          NODE_ENV: 'production',
        }),
      ).toThrow(/DATABASE_URL_APP must be set in production/i);
    });

    it('throws when DATABASE_URL_APP equals the admin connection in production', () => {
      expect(() =>
        resolveDatabaseConnections({
          DATABASE_URL_ADMIN: ADMIN,
          DATABASE_URL_APP: ADMIN,
          NODE_ENV: 'production',
        }),
      ).toThrow(/must not equal the admin connection/i);
    });

    it('throws when the app pool would alias admin via the DATABASE_URL fallback', () => {
      // No DATABASE_URL_ADMIN; admin resolves to DATABASE_URL; app set to the
      // same value -> still the BYPASSRLS role -> must be rejected.
      expect(() =>
        resolveDatabaseConnections({
          DATABASE_URL: ADMIN,
          DATABASE_URL_APP: ADMIN,
          NODE_ENV: 'production',
        }),
      ).toThrow(/must not equal the admin connection/i);
    });

    it('passes when admin and app are distinct in production', () => {
      const r = resolveDatabaseConnections({
        DATABASE_URL_ADMIN: ADMIN,
        DATABASE_URL_APP: APP,
        NODE_ENV: 'production',
      });
      expect(r.adminConnectionString).toBe(ADMIN);
      expect(r.appConnectionString).toBe(APP);
    });
  });

  describe('development convenience (alias allowed)', () => {
    it('allows a missing app connection in development (aliases to admin)', () => {
      const r = resolveDatabaseConnections({
        DATABASE_URL_ADMIN: ADMIN,
        NODE_ENV: 'development',
      });
      expect(r.appConnectionString).toBeUndefined();
    });

    it('allows app equal to admin in development', () => {
      const r = resolveDatabaseConnections({
        DATABASE_URL: ADMIN,
        DATABASE_URL_APP: ADMIN,
        NODE_ENV: 'development',
      });
      expect(r.appConnectionString).toBe(ADMIN);
    });
  });
});
