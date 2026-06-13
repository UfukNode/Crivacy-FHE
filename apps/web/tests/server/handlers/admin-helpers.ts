/**
 * Test helpers for admin handler tests.
 *
 * Builds an AdminContext with mock DB, deterministic clock,
 * and fixed admin user/session data.
 */

import { NextRequest } from 'next/server';

import {
  type AdminContext,
  type ResolvedAdminUser,
  buildAdminContext,
  buildRequestContext,
} from '@/server/context';

import {
  FIXTURE_NOW,
  FIXTURE_REQUEST_ID,
  buildMockDb,
  fixtureClock,
  fixtureRequestIdFactory,
} from '../fixtures';

import type { CrivacyDatabase } from '@/lib/db/client';

/* ---------- Fixed values ---------- */

export const FIXTURE_ADMIN_USER_ID = 'a1111111-1111-4111-8111-111111111111';
export const FIXTURE_ADMIN_SESSION_ID = 'as111111-1111-4111-8111-111111111111';
export const FIXTURE_ADMIN_JTI = 'aj111111-1111-4111-8111-111111111111';

/* ---------- Admin context builder ---------- */

export interface AdminCtxOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  role?: 'superadmin' | 'admin' | 'support';
  /**
   * Override the effective permission set (defaults to empty — Faz 4
   * groundwork; per-scenario opt-in).
   */
  permissions?: ReadonlySet<string>;
}

export function buildAdminCtx(opts: AdminCtxOptions = {}): AdminContext {
  const method = opts.method ?? 'GET';
  const url = opts.url ?? 'https://admin.crivacy.test/api/internal/admin/firms';
  const headers = new Headers(opts.headers ?? {});

  const requestInit: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    requestInit.body = opts.body;
    headers.set('content-type', 'application/json');
  }

  const request = new NextRequest(new Request(url, requestInit));
  const db = buildMockDb();
  const base = buildRequestContext(request, db, fixtureClock, fixtureRequestIdFactory);

  const user: ResolvedAdminUser = {
    id: FIXTURE_ADMIN_USER_ID,
    email: 'admin@crivacy.io',
    displayName: 'Test Admin',
    role: opts.role ?? 'admin',
  };

  return buildAdminContext(
    base,
    user,
    {
      sessionId: FIXTURE_ADMIN_SESSION_ID,
      jti: FIXTURE_ADMIN_JTI,
      kind: 'admin',
    },
    opts.permissions ?? new Set<string>(),
  );
}

/* ---------- Re-exports ---------- */
export { FIXTURE_NOW, FIXTURE_REQUEST_ID, buildMockDb };
export type { CrivacyDatabase };
