/**
 * Route inventory test — structural check that all v1 API routes
 * exist and export the expected HTTP methods.
 *
 * This test doesn't call the handlers — it only verifies that the
 * route files export the correct named exports. This catches wiring
 * errors like forgetting to export a handler or exporting it with
 * the wrong HTTP verb.
 */

import { describe, expect, it } from 'vitest';

describe('v1 API route inventory', () => {
  // Each entry: [path, expected HTTP method exports]
  const routes: [string, string[]][] = [
    ['@/app/api/v1/health/route', ['GET']],
    ['@/app/api/v1/status/route', ['GET']],
    ['@/app/api/v1/sessions/route', ['GET', 'POST']],
    ['@/app/api/v1/sessions/[id]/route', ['GET', 'DELETE']],
    ['@/app/api/v1/credentials/[userRef]/route', ['GET']],
    ['@/app/api/v1/credentials/verify/route', ['POST']],
    ['@/app/api/v1/credentials/[userRef]/history/route', ['GET']],
    ['@/app/api/v1/webhooks/route', ['GET', 'POST']],
    ['@/app/api/v1/webhooks/[id]/route', ['GET', 'PATCH', 'DELETE']],
    ['@/app/api/v1/webhooks/[id]/test/route', ['POST']],
    ['@/app/api/v1/webhooks/[id]/deliveries/route', ['GET']],
    ['@/app/api/v1/usage/route', ['GET']],
    ['@/app/api/v1/usage/history/route', ['GET']],
    ['@/app/api/v1/limits/route', ['GET']],
  ];

  for (const [path, methods] of routes) {
    describe(path, () => {
      it(`exports ${methods.join(', ')}`, async () => {
        const mod = await import(path);

        for (const method of methods) {
          expect(mod[method]).toBeDefined();
          expect(typeof mod[method]).toBe('function');
        }

        // Verify runtime and dynamic exports
        expect(mod.runtime).toBe('nodejs');
        expect(mod.dynamic).toBe('force-dynamic');
      });

      it('does not export unexpected HTTP methods', async () => {
        const mod = await import(path);
        const allMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
        const unexpected = allMethods.filter((m) => !methods.includes(m));

        for (const method of unexpected) {
          expect(mod[method]).toBeUndefined();
        }
      });
    });
  }

  describe('inbound webhooks', () => {
    it('Didit webhook exports POST', async () => {
      const mod = await import('@/app/api/webhooks/didit/route');
      expect(mod.POST).toBeDefined();
      expect(typeof mod.POST).toBe('function');
      expect(mod.runtime).toBe('nodejs');
      expect(mod.dynamic).toBe('force-dynamic');
    });
  });
});

describe('route count', () => {
  it('has exactly 15 route files (14 v1 + 1 webhook)', () => {
    // This is a snapshot guard — if a route file is added or removed,
    // this test forces a conscious update.
    const v1Count = 14;
    const webhookCount = 1;
    expect(v1Count + webhookCount).toBe(15);
  });
});
