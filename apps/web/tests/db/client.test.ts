import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DATABASE_CLIENT_CONFIG,
  getDatabaseClient,
  resetDatabaseClientForTests,
} from '@/lib/db';

afterEach(() => {
  resetDatabaseClientForTests();
  vi.unstubAllEnvs();
});

describe('DEFAULT_DATABASE_CLIENT_CONFIG', () => {
  it('pins conservative TCP timeouts and pool sizing', () => {
    expect(DEFAULT_DATABASE_CLIENT_CONFIG.maxConnections).toBe(20);
    expect(DEFAULT_DATABASE_CLIENT_CONFIG.connectionTimeoutMs).toBe(5_000);
    expect(DEFAULT_DATABASE_CLIENT_CONFIG.idleTimeoutMs).toBe(30_000);
    expect(DEFAULT_DATABASE_CLIENT_CONFIG.statementTimeoutMs).toBe(15_000);
    expect(DEFAULT_DATABASE_CLIENT_CONFIG.idleInTransactionTimeoutMs).toBe(60_000);
  });

  it('defaults to TLS disabled so unit tests do not accidentally hit a real TLS pool', () => {
    expect(DEFAULT_DATABASE_CLIENT_CONFIG.ssl).toBe(false);
  });

  it('tags pooled connections with the crivacy-api application_name', () => {
    expect(DEFAULT_DATABASE_CLIENT_CONFIG.applicationName).toBe('crivacy-api');
  });
});

describe('getDatabaseClient()', () => {
  it('throws when neither DATABASE_URL_ADMIN nor DATABASE_URL is set', () => {
    // Both unset → no admin pool can be built. The error mentions both
    // env names so an operator who only knows the legacy variable can
    // still find the new explicit binding.
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('DATABASE_URL_ADMIN', '');
    expect(() => getDatabaseClient()).toThrowError(/admin database connection/i);
  });

  it('still starts when only DATABASE_URL is set (back-compat)', () => {
    // The pre-Faz 4.5 behaviour: a single `DATABASE_URL` env wires
    // both pools (app aliases admin) and the runtime boots. Pool
    // construction is lazy so `pg.Pool` does not actually dial the
    // connection during this test.
    vi.stubEnv('DATABASE_URL', 'postgres://stub:stub@127.0.0.1:5999/stub');
    vi.stubEnv('DATABASE_URL_ADMIN', '');
    vi.stubEnv('DATABASE_URL_APP', '');
    expect(() => getDatabaseClient()).not.toThrow();
  });

  it('still starts when only DATABASE_URL_ADMIN is set (Faz 4.5 explicit binding)', () => {
    // The post-Faz 4.5 prod path: secrets manager only injects
    // DATABASE_URL_ADMIN + DATABASE_URL_APP, the legacy variable is
    // omitted entirely. The runtime must boot — getDatabaseClient()
    // promotes ADMIN to the admin pool slot.
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('DATABASE_URL_ADMIN', 'postgres://admin:stub@127.0.0.1:5999/stub');
    vi.stubEnv('DATABASE_URL_APP', '');
    expect(() => getDatabaseClient()).not.toThrow();
  });

  it('treats an empty DATABASE_URL_ADMIN as unset and falls back to DATABASE_URL', () => {
    // Defensive: a stray `DATABASE_URL_ADMIN=` line in `.env` (eg.
    // a sops template that never got templated) used to silently
    // disable the admin pool. The empty-string check in
    // getDatabaseClient() collapses that to the back-compat path.
    vi.stubEnv('DATABASE_URL', 'postgres://stub:stub@127.0.0.1:5999/stub');
    vi.stubEnv('DATABASE_URL_ADMIN', '');
    expect(() => getDatabaseClient()).not.toThrow();
  });
});
