/**
 * Test helpers for dashboard handler tests.
 *
 * Builds a DashboardContext with mock DB, deterministic clock,
 * and fixed user/firm/session data.
 */

import { NextRequest } from 'next/server';

import type { FirmTier } from '@crivacy/shared-types';

import type { CrivacyDatabase } from '@/lib/db/client';
import {
  type DashboardContext,
  type ResolvedDashboardUser,
  type ResolvedFirm,
  buildDashboardContext,
  buildRequestContext,
} from '@/server/context';

import {
  FIXTURE_FIRM_ID,
  FIXTURE_NOW,
  FIXTURE_REQUEST_ID,
  buildMockDb,
  fixtureClock,
  fixtureRequestIdFactory,
} from '../fixtures';

/* ---------- Fixed values ---------- */

export const FIXTURE_USER_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_SESSION_ID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_JTI = '33333333-3333-4333-8333-333333333333';

/* ---------- Dashboard context builder ---------- */

export interface DashboardCtxOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  tier?: FirmTier;
  /**
   * Override the effective permission set. Defaults to an empty set
   * (Faz 4 groundwork — individual route handler tests opt in per
   * scenario). Pass `'*'` as a shorthand for "all permissions granted"
   * via the helper below if needed.
   */
  permissions?: ReadonlySet<string>;
}

export function buildDashboardCtx(opts: DashboardCtxOptions = {}): DashboardContext {
  const method = opts.method ?? 'GET';
  const url = opts.url ?? 'https://dashboard.crivacy.test/api/internal/firm';
  const headers = new Headers(opts.headers ?? {});

  const requestInit: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    requestInit.body = opts.body;
    headers.set('content-type', 'application/json');
  }

  const request = new NextRequest(new Request(url, requestInit));
  const db = buildMockDb();
  const base = buildRequestContext(request, db, fixtureClock, fixtureRequestIdFactory);

  const user: ResolvedDashboardUser = {
    id: FIXTURE_USER_ID,
    firmId: FIXTURE_FIRM_ID,
    email: 'user@test-firm.com',
    role: opts.role ?? 'admin',
  };

  const firm: ResolvedFirm = {
    id: FIXTURE_FIRM_ID,
    slug: 'test-firm',
    displayName: 'Test Firm Ltd',
    tier: (opts.tier ?? 'starter') as FirmTier,
    deletedAt: null,
  };

  return buildDashboardContext(
    base,
    user,
    firm,
    {
      sessionId: FIXTURE_SESSION_ID,
      jti: FIXTURE_JTI,
      kind: 'firm',
    },
    // Tests predate RBAC enforcement — default to an empty set so
    // handlers that call `hasPermission(ctx.permissions, …)` behave
    // as "no permissions" unless the test supplies its own fixture.
    opts.permissions ?? new Set<string>(),
  );
}

/* ---------- Re-exports ---------- */
export { FIXTURE_FIRM_ID, FIXTURE_NOW, FIXTURE_REQUEST_ID, buildMockDb };
export type { CrivacyDatabase };
