/**
 * Coverage invariants — guarantees that every route picked up by the
 * registry exposes the full error surface its security tier requires.
 *
 * The route helpers in `routes/helpers.ts` already do this at compile
 * time, but a sloppy hand-rolled `responses: { 200: ... }` would slip
 * through silently. These tests reach into the *generated* document
 * (rather than the registry) so they verify what consumers actually
 * see, not just what the registry was given.
 */

import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '@/lib/openapi';

const document = buildOpenApiDocument();

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

type Operation = {
  tags?: string[];
  summary?: string;
  responses?: Record<string, unknown>;
  security?: unknown[];
  parameters?: unknown[];
};

type RouteEntry = {
  method: HttpMethod;
  path: string;
  operation: Operation;
};

function collectRoutes(): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const paths = document.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, unknown>)[method];
      if (op) {
        routes.push({ method, path, operation: op as Operation });
      }
    }
  }
  return routes;
}

const routes = collectRoutes();

function classify(path: string): 'health' | 'public' | 'internal' | 'admin' | 'inbound' {
  if (path === '/api/v1/health' || path === '/api/v1/status') return 'health';
  if (path.startsWith('/api/v1/')) return 'public';
  if (path.startsWith('/api/internal/')) return 'internal';
  if (path.startsWith('/api/admin/')) return 'admin';
  if (path.startsWith('/api/webhooks/')) return 'inbound';
  throw new Error(`Unclassifiable path in spec: ${path}`);
}

const REQUIRED_ERRORS: Record<ReturnType<typeof classify>, readonly string[]> = {
  public: ['400', '401', '403', '404', '409', '429', '500', '502', '503'],
  internal: ['400', '401', '403', '404', '409', '429', '500'],
  admin: ['400', '401', '403', '404', '409', '500'],
  inbound: ['400', '401', '404', '413', '500'],
  health: ['500', '503'],
} as const;

describe('openapi/coverage', () => {
  it('the registry produced at least one route', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  describe('error response coverage', () => {
    for (const route of routes) {
      const tier = classify(route.path);
      const required = REQUIRED_ERRORS[tier];
      const label = `${route.method.toUpperCase()} ${route.path} (${tier})`;

      it(`${label} declares all required error responses`, () => {
        const responses = route.operation.responses ?? {};
        for (const status of required) {
          expect(
            Object.prototype.hasOwnProperty.call(responses, status),
            `Missing ${status} on ${label}`,
          ).toBe(true);
        }
      });
    }
  });

  describe('success response coverage', () => {
    for (const route of routes) {
      const label = `${route.method.toUpperCase()} ${route.path}`;
      it(`${label} declares at least one 2xx success response`, () => {
        const responses = route.operation.responses ?? {};
        const successCodes = Object.keys(responses).filter((s) => s.startsWith('2'));
        expect(successCodes.length).toBeGreaterThan(0);
      });
    }
  });

  describe('tag coverage', () => {
    it('every route carries at least one tag', () => {
      for (const route of routes) {
        const tags = route.operation.tags ?? [];
        expect(tags.length).toBeGreaterThan(0);
      }
    });

    it('every tag the spec uses is declared in the top-level tags catalog', () => {
      const declared = new Set((document.tags ?? []).map((t) => t.name));
      for (const route of routes) {
        const tags = route.operation.tags ?? [];
        for (const tag of tags) {
          expect(declared.has(tag)).toBe(true);
        }
      }
    });
  });

  describe('summary coverage', () => {
    it('every route has a non-empty summary', () => {
      for (const route of routes) {
        expect(typeof route.operation.summary).toBe('string');
        expect((route.operation.summary ?? '').trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('security coverage', () => {
    it('public, internal, and admin routes declare a security requirement', () => {
      for (const route of routes) {
        const tier = classify(route.path);
        // Auth login, health, status, and inbound webhook routes either
        // skip security entirely or use a dedicated scheme. The single
        // documented exception is `/api/internal/auth/login`, which
        // explicitly opts out via `security: []`.
        if (tier === 'health') continue;
        if (route.path === '/api/internal/auth/login') {
          // Login intentionally has no auth — explicit empty array.
          expect(Array.isArray(route.operation.security)).toBe(true);
          expect((route.operation.security ?? []).length).toBe(0);
          continue;
        }
        const security = route.operation.security ?? [];
        expect(
          Array.isArray(security),
          `${route.method.toUpperCase()} ${route.path} missing security array`,
        ).toBe(true);
        expect(
          security.length,
          `${route.method.toUpperCase()} ${route.path} declares no security requirement`,
        ).toBeGreaterThan(0);
      }
    });
  });
});
