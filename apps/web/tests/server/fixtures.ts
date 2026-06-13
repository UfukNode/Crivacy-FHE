/**
 * Shared test fixtures for the server middleware + context test suites.
 *
 * Provides minimal fakes that satisfy the type contracts without
 * requiring real infrastructure (no Postgres, no Next.js server).
 *
 * The `NextRequest` constructor from `next/server` works in the
 * vitest jsdom environment because it is built on top of the Web
 * `Request` API, which jsdom exposes.
 */

import { NextRequest } from 'next/server';

import type { ApiKeyMode, ApiKeyScope, FirmTier } from '@crivacy/shared-types';

import type { CrivacyDatabase } from '@/lib/db/client';
import type { RateLimitSnapshot, ResolvedApiKey, ResolvedFirm } from '@/server/context';

/* ---------- Fixed values ---------- */

/** Deterministic request ID for assertions. */
export const FIXTURE_REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Deterministic clock — 2026-04-10 12:00:00 UTC. */
export const FIXTURE_NOW = new Date('2026-04-10T12:00:00.000Z');

/** Factory that always returns `FIXTURE_REQUEST_ID`. */
export const fixtureRequestIdFactory = (): string => FIXTURE_REQUEST_ID;

/** Factory that always returns `FIXTURE_NOW`. */
export const fixtureClock = (): Date => FIXTURE_NOW;

/** Fixture firm ID. */
export const FIXTURE_FIRM_ID = 'f1111111-1111-4111-8111-111111111111';

/** Fixture API key ID. */
export const FIXTURE_API_KEY_ID = 'k1111111-1111-4111-8111-111111111111';

/* ---------- Mock DB ---------- */

/**
 * Build a minimal CrivacyDatabase mock.
 *
 * Context tests only thread `db` through — they never call any
 * query method, so a bare object would do for them. Dashboard
 * handler tests, on the other hand, dependency-inject their real
 * repository writers and then call `db.transaction(cb)` /
 * `db.execute(sql)` through the handler path (e.g. advisory locks
 * around tier caps). The callback-style `transaction` hands back
 * the same `db` as `tx`, which lets those handlers funnel their
 * writes through the injected repos unchanged. `execute` is a
 * no-op; the raw SQL it receives is either an advisory lock or a
 * read that the test suite never inspects directly.
 */
export function buildMockDb(): CrivacyDatabase {
  const db: Record<string, unknown> = {
    _tag: 'mock-db',
    execute: async () => ({ rows: [] }),
  };
  db['transaction'] = async <T>(
    cb: (tx: CrivacyDatabase) => Promise<T>,
  ): Promise<T> => cb(db as unknown as CrivacyDatabase);
  return db as unknown as CrivacyDatabase;
}

/* ---------- Request builder ---------- */

export interface TestRequestOptions {
  /** HTTP method. @default 'GET' */
  method?: string;
  /** Full URL. @default 'https://api.crivacy.test/api/v1/health' */
  url?: string;
  /** Additional headers to set. */
  headers?: Record<string, string>;
}

/**
 * Build a `NextRequest` with the given options. The request is
 * created via the `NextRequest` constructor so it carries the full
 * Next.js API surface.
 */
export function buildTestRequest(opts: TestRequestOptions = {}): NextRequest {
  const method = opts.method ?? 'GET';
  const url = opts.url ?? 'https://api.crivacy.test/api/v1/health';
  const headers = new Headers(opts.headers ?? {});
  return new NextRequest(new Request(url, { method, headers }));
}

/* ---------- Resolved entities ---------- */

export function buildResolvedApiKey(overrides: Partial<ResolvedApiKey> = {}): ResolvedApiKey {
  return {
    id: FIXTURE_API_KEY_ID,
    firmId: FIXTURE_FIRM_ID,
    prefix: 'crv_live_test1234',
    name: 'Test API Key',
    scopes: ['kyc:create', 'kyc:read'] as readonly ApiKeyScope[],
    mode: 'live' as ApiKeyMode,
    ...overrides,
  };
}

export function buildResolvedFirm(overrides: Partial<ResolvedFirm> = {}): ResolvedFirm {
  return {
    id: FIXTURE_FIRM_ID,
    slug: 'test-firm',
    displayName: 'Test Firm Ltd',
    tier: 'starter' as FirmTier,
    deletedAt: null,
    ...overrides,
  };
}

export function buildRateLimitSnapshot(
  overrides: Partial<RateLimitSnapshot> = {},
): RateLimitSnapshot {
  return {
    limit: 100,
    remaining: 42,
    resetSeconds: 60,
    ...overrides,
  };
}
