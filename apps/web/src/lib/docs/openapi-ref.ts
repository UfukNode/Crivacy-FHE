/**
 * OpenAPI spec parser for the auto-generated API reference page.
 *
 * Reads `docs/api/openapi.json` at build time and structures endpoint data
 * into tag-grouped sections suitable for rendering.
 *
 * @module
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ApiEndpoint {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly security: readonly string[];
  readonly parameters: readonly ApiParameter[];
  readonly requestBody: ApiRequestBody | null;
  readonly responses: ReadonlyArray<{ status: string; description: string }>;
  readonly minTier: string | null;
  readonly deprecated: boolean;
}

export interface ApiParameter {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly description: string;
  /** Human-readable type description (e.g. `"string"`, `"MySchema"`, `"string[]"`). */
  readonly schema: string;
}

export interface ApiRequestBody {
  readonly contentType: string;
  readonly description: string;
  readonly required: boolean;
  readonly schemaRef: string | null;
}

export interface ApiTagGroup {
  readonly tag: string;
  readonly description: string;
  readonly endpoints: readonly ApiEndpoint[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and parse the OpenAPI spec from `docs/api/openapi.json`.
 *
 * @param specPath - override the default spec location (useful for tests)
 */
export function loadApiReference(specPath?: string | undefined): readonly ApiTagGroup[] {
  const resolvedPath =
    specPath ?? path.join(process.cwd(), '..', '..', 'docs', 'api', 'openapi.json');

  if (!fs.existsSync(resolvedPath)) return [];

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  // biome-ignore lint/suspicious/noExplicitAny: OpenAPI spec is a dynamic JSON structure
  const spec = JSON.parse(raw) as Record<string, any>;

  return parseSpec(spec);
}

// ---------------------------------------------------------------------------
// Spec parser
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI spec is a dynamic JSON structure
function parseSpec(spec: Record<string, any>): readonly ApiTagGroup[] {
  // biome-ignore lint/suspicious/noExplicitAny: OpenAPI spec paths object
  const paths = (spec['paths'] ?? {}) as Record<string, Record<string, any>>;
  // biome-ignore lint/suspicious/noExplicitAny: OpenAPI spec tags array
  const tags = (spec['tags'] ?? []) as Array<Record<string, any>>;

  // Build a tag-name -> description lookup
  const tagMap = new Map<string, string>();
  for (const tag of tags) {
    const name = typeof tag['name'] === 'string' ? tag['name'] : '';
    const desc = typeof tag['description'] === 'string' ? tag['description'] : '';
    if (name.length > 0) tagMap.set(name, desc);
  }

  // Collect endpoints grouped by their first tag
  const endpointsByTag = new Map<string, ApiEndpoint[]>();

  for (const [pathStr, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method === 'parameters') continue; // path-level params, skip

      const endpoint = parseOperation(method.toUpperCase(), pathStr, operation);

      for (const tag of endpoint.tags) {
        const existing = endpointsByTag.get(tag);
        if (existing !== undefined) {
          existing.push(endpoint);
        } else {
          endpointsByTag.set(tag, [endpoint]);
        }
      }

      // If no tags, bucket under "Other"
      if (endpoint.tags.length === 0) {
        const existing = endpointsByTag.get('Other');
        if (existing !== undefined) {
          existing.push(endpoint);
        } else {
          endpointsByTag.set('Other', [endpoint]);
        }
      }
    }
  }

  // Build the tag groups
  const groups: ApiTagGroup[] = [];
  for (const [tag, endpoints] of endpointsByTag) {
    groups.push({
      tag,
      description: tagMap.get(tag) ?? '',
      endpoints,
    });
  }

  // Sort by tag order from spec (unrecognised tags go last)
  const tagOrder = new Map<string, number>();
  tags.forEach((t, i) => {
    const name = typeof t['name'] === 'string' ? t['name'] : '';
    tagOrder.set(name, i);
  });

  groups.sort((a, b) => (tagOrder.get(a.tag) ?? 999) - (tagOrder.get(b.tag) ?? 999));

  return groups;
}

// ---------------------------------------------------------------------------
// Operation parser
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI operation object
function parseOperation(method: string, pathStr: string, op: Record<string, any>): ApiEndpoint {
  const opTags = Array.isArray(op['tags']) ? (op['tags'] as string[]) : [];
  const opParams = Array.isArray(op['parameters']) ? op['parameters'] : [];
  // biome-ignore lint/suspicious/noExplicitAny: OpenAPI responses object
  const opResponses = (op['responses'] ?? {}) as Record<string, any>;
  const opSecurity = Array.isArray(op['security']) ? op['security'] : [];

  // Parameters
  const parameters: ApiParameter[] = [];
  for (const param of opParams) {
    if (typeof param !== 'object' || param === null) continue;
    parameters.push({
      name: typeof param['name'] === 'string' ? param['name'] : '',
      in: typeof param['in'] === 'string' ? param['in'] : '',
      required: param['required'] === true,
      description: typeof param['description'] === 'string' ? param['description'] : '',
      schema: describeSchema(param['schema']),
    });
  }

  // Request body
  let requestBody: ApiRequestBody | null = null;
  if (typeof op['requestBody'] === 'object' && op['requestBody'] !== null) {
    const rb = op['requestBody'] as Record<string, unknown>;
    const content =
      typeof rb['content'] === 'object' && rb['content'] !== null
        ? (rb['content'] as Record<string, unknown>)
        : {};
    const contentType = Object.keys(content)[0] ?? 'application/json';
    const mediaType = content[contentType] as Record<string, unknown> | undefined;
    requestBody = {
      contentType,
      description: typeof rb['description'] === 'string' ? rb['description'] : '',
      required: rb['required'] === true,
      schemaRef: extractSchemaRef(mediaType?.['schema']),
    };
  }

  // Responses
  const responses: Array<{ status: string; description: string }> = [];
  for (const [status, resp] of Object.entries(opResponses)) {
    const desc =
      typeof resp === 'object' &&
      resp !== null &&
      typeof (resp as Record<string, unknown>)['description'] === 'string'
        ? ((resp as Record<string, unknown>)['description'] as string)
        : '';
    responses.push({ status, description: desc });
  }

  // Security scheme names
  const securityNames: string[] = [];
  for (const secItem of opSecurity) {
    if (typeof secItem === 'object' && secItem !== null) {
      for (const key of Object.keys(secItem as Record<string, unknown>)) {
        securityNames.push(key);
      }
    }
  }

  return {
    method,
    path: pathStr,
    operationId: typeof op['operationId'] === 'string' ? op['operationId'] : '',
    summary: typeof op['summary'] === 'string' ? op['summary'] : '',
    description: typeof op['description'] === 'string' ? op['description'] : '',
    tags: opTags,
    security: securityNames,
    parameters,
    requestBody,
    responses,
    minTier: typeof op['x-crivacy-min-tier'] === 'string' ? op['x-crivacy-min-tier'] : null,
    deprecated: op['deprecated'] === true,
  };
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/** Produce a human-readable type string from an OpenAPI schema object. */
function describeSchema(schema: unknown): string {
  if (schema === undefined || schema === null) return 'unknown';
  if (typeof schema !== 'object') return String(schema);

  const s = schema as Record<string, unknown>;

  if (typeof s['$ref'] === 'string') {
    const ref = s['$ref'];
    const name = ref.split('/').pop() ?? ref;
    return name;
  }

  const type = typeof s['type'] === 'string' ? s['type'] : '';

  if (type === 'array') {
    const items = describeSchema(s['items']);
    return `${items}[]`;
  }

  if (Array.isArray(s['enum'])) {
    return (s['enum'] as unknown[]).map(String).join(' | ');
  }

  return type || 'object';
}

/** Extract the last segment of a `$ref` pointer, or `null`. */
function extractSchemaRef(schema: unknown): string | null {
  if (schema === undefined || schema === null) return null;
  if (typeof schema !== 'object') return null;

  const s = schema as Record<string, unknown>;
  if (typeof s['$ref'] === 'string') {
    const ref = s['$ref'];
    return ref.split('/').pop() ?? null;
  }
  return null;
}
