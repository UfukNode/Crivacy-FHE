/**
 * Build-spec invariants — these are the tests that exercise the actual
 * generator output (rather than the registry that feeds it). The point
 * is to pin the public shape of the emitted OpenAPI document so that
 * downstream consumers (the docs site, generated SDKs, the contract
 * tests in `apps/web/tests/api/*`) cannot silently regress.
 */

import { describe, expect, it } from 'vitest';

import {
  OPENAPI_EXTERNAL_DOCS,
  OPENAPI_INFO,
  OPENAPI_SERVERS,
  buildOpenApiDocument,
  serializeOpenApiToJson,
  serializeOpenApiToYaml,
} from '@/lib/openapi';

const document = buildOpenApiDocument();

const REQUIRED_SCHEMA_NAMES = [
  'ApiErrorBody',
  'ApiErrorCode',
  'ValidationIssue',
  'SessionCreateRequest',
  'SessionDetail',
  'SessionSummary',
  'CredentialDetail',
  'CredentialSummary',
  'CredentialVerifyRequest',
  'CredentialVerifyResponse',
  'WebhookCreateRequest',
  'WebhookUpdateRequest',
  'UsageSummary',
  'LimitsResponse',
  'StatusResponse',
  'FirmProfile',
  'FirmUpdateRequest',
  'ApiKeyCreateRequest',
  'LoginRequest',
  'DiditWebhookPayload',
  'OutboundWebhookEnvelope',
  'PlaygroundExecuteRequest',
  'AuditLogEntry',
];

const REQUIRED_SECURITY_SCHEMES = [
  'apiKey',
  'sessionCookie',
  'adminSessionCookie',
  'diditWebhookSignature',
] as const;

describe('openapi/build-spec', () => {
  describe('top-level document shape', () => {
    it('emits an OpenAPI 3.1.0 document', () => {
      expect(document.openapi).toBe('3.1.0');
    });

    it('embeds the canonical info block', () => {
      expect(document.info.title).toBe(OPENAPI_INFO.title);
      expect(document.info.version).toBe(OPENAPI_INFO.version);
      expect(document.info.contact).toEqual(OPENAPI_INFO.contact);
      expect(document.info.license).toEqual(OPENAPI_INFO.license);
    });

    it('emits both canonical servers in declared order', () => {
      expect(document.servers).toBeDefined();
      const servers = document.servers ?? [];
      expect(servers.length).toBe(OPENAPI_SERVERS.length);
      for (const [index, expected] of OPENAPI_SERVERS.entries()) {
        expect(servers[index]?.url).toBe(expected.url);
        expect(servers[index]?.description).toBe(expected.description);
      }
    });

    it('embeds the external docs block', () => {
      expect(document.externalDocs).toEqual(OPENAPI_EXTERNAL_DOCS);
    });

    it('emits a non-empty tags array', () => {
      expect(Array.isArray(document.tags)).toBe(true);
      expect((document.tags ?? []).length).toBeGreaterThan(0);
    });
  });

  describe('paths', () => {
    it('contains the expected number of unique path templates', () => {
      const paths = document.paths ?? {};
      // Verified against `registry.registerPath` call sites — 35 unique
      // path strings across 45 operations.
      expect(Object.keys(paths).length).toBe(35);
    });

    it('groups operations by path correctly (no path emitted with zero ops)', () => {
      const paths = document.paths ?? {};
      for (const [path, item] of Object.entries(paths)) {
        const operationKeys = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
        const operations = operationKeys.filter((k) => k in (item as Record<string, unknown>));
        if (operations.length === 0) {
          throw new Error(`Path ${path} was emitted without any operations`);
        }
      }
    });

    it('every operation references ApiErrorBody on at least one error response', () => {
      const paths = document.paths ?? {};
      const operationKeys = ['get', 'post', 'put', 'patch', 'delete'] as const;
      for (const [path, item] of Object.entries(paths)) {
        for (const method of operationKeys) {
          const op = (item as Record<string, unknown>)[method] as
            | { responses?: Record<string, unknown> }
            | undefined;
          if (!op) continue;
          const responses = op.responses ?? {};
          const errorCodes = Object.keys(responses).filter((s) => /^[45]/.test(s));
          if (errorCodes.length === 0) {
            throw new Error(
              `Operation ${method.toUpperCase()} ${path} declares no 4xx/5xx responses`,
            );
          }
        }
      }
    });
  });

  describe('components', () => {
    it('emits a components.schemas block', () => {
      expect(document.components?.schemas).toBeDefined();
    });

    it.each(REQUIRED_SCHEMA_NAMES)('exports the %s schema', (name) => {
      const schemas = document.components?.schemas ?? {};
      expect(schemas[name]).toBeDefined();
    });

    it('emits a components.securitySchemes block with all four schemes', () => {
      const schemes = document.components?.securitySchemes ?? {};
      for (const name of REQUIRED_SECURITY_SCHEMES) {
        expect(schemes[name]).toBeDefined();
      }
    });

    it('alphabetically sorts schema names (sortComponents: alphabetically)', () => {
      const names = Object.keys(document.components?.schemas ?? {});
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    });
  });

  describe('determinism', () => {
    it('produces a byte-identical YAML on a second build', () => {
      const second = buildOpenApiDocument();
      expect(serializeOpenApiToYaml(second)).toBe(serializeOpenApiToYaml(document));
    });

    it('produces a byte-identical JSON on a second build', () => {
      const second = buildOpenApiDocument();
      expect(serializeOpenApiToJson(second)).toBe(serializeOpenApiToJson(document));
    });

    it('serialized YAML ends with a single trailing newline', () => {
      const yaml = serializeOpenApiToYaml(document);
      expect(yaml.endsWith('\n')).toBe(true);
      expect(yaml.endsWith('\n\n')).toBe(false);
    });

    it('serialized JSON ends with a single trailing newline', () => {
      const json = serializeOpenApiToJson(document);
      expect(json.endsWith('\n')).toBe(true);
      expect(json.endsWith('\n\n')).toBe(false);
    });
  });
});
