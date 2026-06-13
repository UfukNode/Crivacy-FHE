// @vitest-environment node
/**
 * Tests for dashboard-route middleware (JWT auth pipeline).
 *
 * Tests the full pipeline: token extraction → JWT verify →
 * session lookup → firm user lookup → firm lookup → role check →
 * handler execution.
 */

import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { signAccessToken } from '@/lib/auth/jwt';
import type { SessionRow } from '@/server/middleware/dashboard-route';
import {
  dashboardRoute,
  extractToken,
  meetsRoleRequirement,
} from '@/server/middleware/dashboard-route';

import { buildTestConfig } from '../auth/fixtures';
import { FIXTURE_FIRM_ID, FIXTURE_NOW, buildMockDb } from './fixtures';

/**
 * The real `resolveEffectivePermissions` runs a 4-way Drizzle join
 * which `buildMockDb()` does not support. These tests predate RBAC
 * enforcement and do not care about the permission set — they just
 * need the pipeline to reach the handler. Inject an empty-set stub
 * so the middleware's permission-resolution step is a no-op.
 */
const STUB_PERMISSIONS_RESOLVER = async (): Promise<Set<string>> => new Set();

/* ---------- Fixed values ---------- */

const FIXTURE_USER_ID = 'u1111111-1111-4111-8111-111111111111';
const FIXTURE_JTI = 'j1111111-1111-4111-8111-111111111111';
const FIXTURE_SESSION_ID = 's1111111-1111-4111-8111-111111111111';

const AUTH_CONFIG = buildTestConfig();

/* ---------- Helpers ---------- */

async function buildValidToken(): Promise<string> {
  const signed = await signAccessToken(
    {
      sub: FIXTURE_USER_ID,
      jti: FIXTURE_JTI,
      kind: 'firm',
      firmId: FIXTURE_FIRM_ID,
      role: 'admin',
    },
    AUTH_CONFIG,
    FIXTURE_NOW,
  );
  return signed.token;
}

function buildSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: FIXTURE_SESSION_ID,
    userId: FIXTURE_USER_ID,
    userKind: 'firm',
    revokedAt: null,
    ...overrides,
  };
}

function buildFirmUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FIXTURE_USER_ID,
    firmId: FIXTURE_FIRM_ID,
    email: 'user@test-firm.com',
    role: 'admin' as const,
    lockedAt: null,
    ...overrides,
  };
}

function buildFirmRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FIXTURE_FIRM_ID,
    slug: 'test-firm',
    displayName: 'Test Firm Ltd',
    tier: 'starter' as const,
    deletedAt: null,
    ...overrides,
  };
}

function buildRequest(token?: string | null, method = 'GET'): NextRequest {
  const headers = new Headers();
  if (token !== undefined && token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return new NextRequest(
    new Request('https://dashboard.crivacy.test/api/internal/firm', { method, headers }),
  );
}

/* ---------- extractToken ---------- */

describe('extractToken', () => {
  it('extracts from Authorization header', () => {
    const req = buildRequest('my-jwt-token');
    expect(extractToken(req)).toBe('my-jwt-token');
  });

  it('extracts from cookie when no header', () => {
    const req = new NextRequest(new Request('https://dashboard.crivacy.test/api/internal/firm'));
    // Manually set cookie via headers (NextRequest reads from cookie header)
    const reqWithCookie = new NextRequest(
      new Request('https://dashboard.crivacy.test/api/internal/firm', {
        headers: { cookie: '__crivacy_at=cookie-jwt-token' },
      }),
    );
    expect(extractToken(reqWithCookie)).toBe('cookie-jwt-token');
    // No token at all
    expect(extractToken(req)).toBeNull();
  });

  it('prefers Authorization header over cookie', () => {
    const req = new NextRequest(
      new Request('https://dashboard.crivacy.test/api/internal/firm', {
        headers: {
          authorization: 'Bearer header-token',
          cookie: '__crivacy_at=cookie-token',
        },
      }),
    );
    expect(extractToken(req)).toBe('header-token');
  });

  it('returns null for empty Bearer value', () => {
    const req = new NextRequest(
      new Request('https://dashboard.crivacy.test/api/internal/firm', {
        headers: { authorization: 'Bearer ' },
      }),
    );
    expect(extractToken(req)).toBeNull();
  });

  it('returns null for non-Bearer authorization', () => {
    const req = new NextRequest(
      new Request('https://dashboard.crivacy.test/api/internal/firm', {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      }),
    );
    expect(extractToken(req)).toBeNull();
  });
});

/* ---------- meetsRoleRequirement ---------- */

describe('meetsRoleRequirement', () => {
  it('viewer meets viewer', () => {
    expect(meetsRoleRequirement('viewer', 'viewer')).toBe(true);
  });

  it('admin meets member', () => {
    expect(meetsRoleRequirement('admin', 'member')).toBe(true);
  });

  it('owner meets admin', () => {
    expect(meetsRoleRequirement('owner', 'admin')).toBe(true);
  });

  it('member does not meet admin', () => {
    expect(meetsRoleRequirement('member', 'admin')).toBe(false);
  });

  it('viewer does not meet member', () => {
    expect(meetsRoleRequirement('viewer', 'member')).toBe(false);
  });
});

/* ---------- dashboardRoute full pipeline ---------- */

describe('dashboardRoute', () => {
  it('returns 401 when no token is present', async () => {
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn(),
      firmUserLookup: vi.fn(),
      firmLookup: vi.fn(),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: STUB_PERMISSIONS_RESOLVER,
    });

    const res = await route(buildRequest(null));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 for invalid JWT', async () => {
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn(),
      firmUserLookup: vi.fn(),
      firmLookup: vi.fn(),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: STUB_PERMISSIONS_RESOLVER,
    });

    const res = await route(buildRequest('invalid-jwt'));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 when session not found', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(null),
      firmUserLookup: vi.fn(),
      firmLookup: vi.fn(),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: STUB_PERMISSIONS_RESOLVER,
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 when session is revoked', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow({ revokedAt: FIXTURE_NOW })),
      firmUserLookup: vi.fn(),
      firmLookup: vi.fn(),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: STUB_PERMISSIONS_RESOLVER,
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 when firm user not found', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow()),
      firmUserLookup: vi.fn().mockResolvedValue(null),
      firmLookup: vi.fn(),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: STUB_PERMISSIONS_RESOLVER,
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 when user is locked', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow()),
      firmUserLookup: vi.fn().mockResolvedValue(buildFirmUserRow({ lockedAt: FIXTURE_NOW })),
      firmLookup: vi.fn(),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: STUB_PERMISSIONS_RESOLVER,
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 when firm not found', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow()),
      firmUserLookup: vi.fn().mockResolvedValue(buildFirmUserRow()),
      firmLookup: vi.fn().mockResolvedValue(null),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: STUB_PERMISSIONS_RESOLVER,
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 when firm is deleted', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow()),
      firmUserLookup: vi.fn().mockResolvedValue(buildFirmUserRow()),
      firmLookup: vi.fn().mockResolvedValue(buildFirmRow({ deletedAt: FIXTURE_NOW })),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: STUB_PERMISSIONS_RESOLVER,
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  // Legacy minRole hierarchy test removed in Faz 17 — the middleware
  // no longer accepts a `minRole` option. Equivalent coverage lives in
  // the permission-gate tests below ("returns 403 permission_denied
  // when permission option set and caller lacks it").

  it('calls handler with DashboardContext on success', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ result: 'ok' }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow()),
      firmUserLookup: vi.fn().mockResolvedValue(buildFirmUserRow()),
      firmLookup: vi.fn().mockResolvedValue(buildFirmRow()),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: STUB_PERMISSIONS_RESOLVER,
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();

    // Check that context has the right shape
    const ctx = handler.mock.calls[0]?.[0];
    expect(ctx).toBeDefined();
    expect(ctx.user.id).toBe(FIXTURE_USER_ID);
    expect(ctx.user.role).toBe('admin');
    expect(ctx.firm.id).toBe(FIXTURE_FIRM_ID);
    expect(ctx.session.jti).toBe(FIXTURE_JTI);
    expect(ctx.session.kind).toBe('firm');
  });

  it('defaults minRole to viewer', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow()),
      firmUserLookup: vi.fn().mockResolvedValue(buildFirmUserRow({ role: 'viewer' })),
      firmLookup: vi.fn().mockResolvedValue(buildFirmRow()),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: STUB_PERMISSIONS_RESOLVER,
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  /* ---------- Permission gate ---------- */

  it('returns 403 permission_denied when permission option set and caller lacks it', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      permission: 'webhook.delete',
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow()),
      firmUserLookup: vi.fn().mockResolvedValue(buildFirmUserRow()),
      firmLookup: vi.fn().mockResolvedValue(buildFirmRow()),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      // Stub returns a set missing `webhook.delete` — the middleware
      // should reject before the handler runs.
      permissionsResolver: async () => new Set(['webhook.read', 'webhook.create']),
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.error.code).toBe('permission_denied');
    expect(body.error.message).toContain('webhook.delete');
  });

  it('calls handler when permission option set and caller has it', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      permission: 'webhook.delete',
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow()),
      firmUserLookup: vi.fn().mockResolvedValue(buildFirmUserRow()),
      firmLookup: vi.fn().mockResolvedValue(buildFirmRow()),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      permissionsResolver: async () =>
        new Set(['webhook.read', 'webhook.delete', 'webhook.create']),
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('populates ctx.permissions with the resolved set', async () => {
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow()),
      firmUserLookup: vi.fn().mockResolvedValue(buildFirmUserRow()),
      firmLookup: vi.fn().mockResolvedValue(buildFirmRow()),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      // No `permission` option — middleware still resolves the set
      // and threads it into the context for handler-level guards
      // (e.g. `.own` / `.any` ownership checks).
      permissionsResolver: async () =>
        new Set(['api_key.read', 'api_key.rotate.own', 'api_key.revoke.own']),
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(200);

    const ctx = handler.mock.calls[0]?.[0];
    expect(ctx.permissions).toBeInstanceOf(Set);
    expect(ctx.permissions.has('api_key.rotate.own')).toBe(true);
    expect(ctx.permissions.has('api_key.rotate.any')).toBe(false);
  });

  it('allows request when no permission option is declared', async () => {
    // Regression guard — routes without a `permission:` option (e.g.
    // the `/me` + `/logout` surfaces) must never block on permissions.
    const token = await buildValidToken();
    const handler = vi.fn().mockReturnValue(NextResponse.json({ ok: true }));
    const route = dashboardRoute({
      handler,
      authConfig: AUTH_CONFIG,
      sessionLookup: vi.fn().mockResolvedValue(buildSessionRow()),
      firmUserLookup: vi.fn().mockResolvedValue(buildFirmUserRow()),
      firmLookup: vi.fn().mockResolvedValue(buildFirmRow()),
      dbFactory: () => buildMockDb(),
      clock: () => FIXTURE_NOW,
      // Empty set: if middleware enforced, this would 403 every
      // request. It must not, because no `permission` is declared.
      permissionsResolver: async () => new Set(),
    });

    const res = await route(buildRequest(token));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});
