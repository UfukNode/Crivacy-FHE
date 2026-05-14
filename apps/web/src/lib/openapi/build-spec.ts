/**
 * OpenAPI document builder.
 *
 * Importing this module has a side effect: it pulls in every route
 * registration through the `routes/index` barrel, then invokes the
 * OpenAPI 3.1 generator over the shared registry. The result is a
 * plain JS object that any caller — the build script, the docs page,
 * a test, a runtime middleware — can serialize to JSON or YAML.
 *
 * The generator is deterministic as long as the registry definitions
 * are deterministic: every schema is registered by name, every route
 * path is registered with a stable order (imports in the route barrels
 * are alphabetical), and every security scheme is registered up front.
 * `tests/openapi/build-spec.test.ts` pins this determinism with a
 * two-build idempotency assertion.
 */

import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { stringify as yamlStringify } from 'yaml';

import { orderedTags, registry } from './registry';

// Importing the routes barrel is the single side effect that populates
// `registry.definitions`. Do not remove this import — the registry is
// empty without it and the generator will emit an empty document.
import './routes';

/**
 * Canonical document info. These values live in the generated spec's
 * `info` block. Update the version here when you intentionally ship a
 * breaking schema change; the committed `docs/api/openapi.yaml` will
 * fail `openapi-check` until the bump is committed alongside the
 * schema change, which is the whole point of the check script.
 */
export const OPENAPI_INFO = {
  title: 'Crivacy KYC API',
  version: '1.0.0',
  description:
    'Crivacy is a FHE-powered re-usable KYC credential system. This spec describes three surfaces — the public B2B API (`/api/v1/*`), the dashboard internal API (`/api/internal/*`), and the Crivacy admin API (`/api/admin/*`) — plus the inbound Didit webhook. Every schema is generated from the Zod definitions in `apps/web/src/lib/openapi/schemas`; runtime request handlers import the exact same schemas for validation, so this document is always in sync with what the server accepts.',
  contact: {
    name: 'Crivacy',
    url: 'https://crivacy.io',
    email: 'support@crivacy.io',
  },
  license: {
    name: 'Proprietary — © Crivacy',
    url: 'https://crivacy.io/terms',
  },
} as const;

/**
 * Server URLs emitted in the spec. The first entry is the canonical
 * production base; the second is the dashboard's built-in playground
 * which proxies every request through the internal surface. We do not
 * emit a localhost entry — local development is opt-in via tooling, not
 * a spec concern.
 */
export const OPENAPI_SERVERS = [
  {
    url: 'https://api.crivacy.io',
    description: 'Production API.',
  },
  {
    url: 'https://app.crivacy.io/api/internal/playground',
    description: 'Dashboard playground proxy. Uses the session cookie instead of an API key.',
  },
] as const;

/** Long-form description blocks that render on the top of the docs site. */
export const OPENAPI_EXTERNAL_DOCS = {
  description: 'Developer docs, onboarding guides, and changelog.',
  url: 'https://docs.crivacy.io',
} as const;

/**
 * Build the full OpenAPI 3.1 document. Pure function — no I/O. Callers
 * that want the document as JSON just `JSON.stringify(buildOpenApiDocument())`;
 * callers that want YAML use `serializeOpenApiToYaml`.
 */
export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions, {
    sortComponents: 'alphabetically',
  });

  return generator.generateDocument({
    openapi: '3.1.0',
    info: OPENAPI_INFO,
    servers: [...OPENAPI_SERVERS],
    tags: orderedTags.map((t) => ({ name: t.name, description: t.description })),
    externalDocs: OPENAPI_EXTERNAL_DOCS,
  });
}

/**
 * Serialize the OpenAPI document to YAML. The output uses 2-space
 * indentation, a stable key order where the generator allows it, and
 * a trailing newline so that `git diff` stays minimal on regeneration.
 */
export function serializeOpenApiToYaml(document: ReturnType<typeof buildOpenApiDocument>): string {
  const body = yamlStringify(document, {
    indent: 2,
    lineWidth: 100,
    minContentWidth: 40,
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
  });
  return body.endsWith('\n') ? body : `${body}\n`;
}

/** Serialize the OpenAPI document to pretty-printed JSON with trailing newline. */
export function serializeOpenApiToJson(document: ReturnType<typeof buildOpenApiDocument>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
