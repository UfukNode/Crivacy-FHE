/**
 * Registry invariants.
 *
 * Every route file is imported through the routes barrel for its
 * side-effect registration. After the barrel has loaded, the registry
 * must hold the full set of security schemes, the expected route count,
 * and every route tag must come from the declared tag catalog. Schema
 * components are discovered by the generator at emit time (via the
 * `.openapi('Name', ...)` metadata hook), so they are verified through
 * the built document in `build-spec.test.ts` rather than here.
 */

import { describe, expect, it } from 'vitest';

import { OpenApiTags, orderedTags, registry } from '@/lib/openapi/registry';
import '@/lib/openapi/routes';

const definitions = registry.definitions;

const EXPECTED_ROUTE_COUNT = 45;

function routeDefinitions() {
  return definitions.filter((d): d is Extract<typeof d, { type: 'route' }> => d.type === 'route');
}

function componentDefinitionsOfType(componentType: string) {
  return definitions.filter(
    (d): d is Extract<typeof d, { type: 'component' }> =>
      d.type === 'component' && d.componentType === (componentType as never),
  );
}

describe('openapi/registry', () => {
  it('registers every security scheme once', () => {
    const schemes = componentDefinitionsOfType('securitySchemes').map((c) => c.name);
    expect(new Set(schemes)).toEqual(
      new Set(['apiKey', 'sessionCookie', 'adminSessionCookie', 'diditWebhookSignature']),
    );
  });

  it('registers no duplicate security scheme names', () => {
    const schemes = componentDefinitionsOfType('securitySchemes').map((c) => c.name);
    expect(new Set(schemes).size).toBe(schemes.length);
  });

  it('registers the expected route count', () => {
    const routes = routeDefinitions();
    expect(routes.length).toBe(EXPECTED_ROUTE_COUNT);
  });

  it('registers no duplicate (method, path) pairs', () => {
    const seen = new Set<string>();
    for (const definition of routeDefinitions()) {
      const key = `${definition.route.method.toUpperCase()} ${definition.route.path}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate route registration: ${key}`);
      }
      seen.add(key);
    }
  });

  it('every route tag is present in the tag catalog', () => {
    const allowed = new Set(orderedTags.map((t) => t.name as string));
    for (const definition of routeDefinitions()) {
      const tags = definition.route.tags ?? [];
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(allowed.has(tag)).toBe(true);
      }
    }
  });

  it('every route carries a summary', () => {
    for (const definition of routeDefinitions()) {
      expect(typeof definition.route.summary).toBe('string');
      expect(definition.route.summary ?? '').not.toBe('');
    }
  });

  it('every route declares a responses map with at least a 2xx entry', () => {
    for (const definition of routeDefinitions()) {
      const responses = definition.route.responses;
      expect(responses).toBeDefined();
      const successCodes = Object.keys(responses).filter((s) => s.startsWith('2'));
      expect(successCodes.length).toBeGreaterThan(0);
    }
  });

  it('orderedTags matches the OpenApiTags catalog', () => {
    const catalogValues = Object.values(OpenApiTags);
    const orderedNames = orderedTags.map((t) => t.name);
    expect(new Set(orderedNames)).toEqual(new Set(catalogValues));
  });
});
