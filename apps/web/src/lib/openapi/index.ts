/**
 * Public entry point for the OpenAPI module.
 *
 * Runtime code (request handlers, the docs page, tests) imports from
 * this barrel. The registry itself is intentionally not re-exported —
 * it is an internal implementation detail. Callers interact with:
 *
 *   - `buildOpenApiDocument` / `serializeOpenApiToYaml` /
 *     `serializeOpenApiToJson` for emitting the spec;
 *   - `OPENAPI_INFO`, `OPENAPI_SERVERS`, `OPENAPI_EXTERNAL_DOCS` as the
 *     canonical document metadata;
 *   - Named Zod schemas from the `schemas` submodule for request and
 *     response validation inside handlers.
 */

export {
  OPENAPI_EXTERNAL_DOCS,
  OPENAPI_INFO,
  OPENAPI_SERVERS,
  buildOpenApiDocument,
  serializeOpenApiToJson,
  serializeOpenApiToYaml,
} from './build-spec';

export { OpenApiTags, orderedTags } from './registry';
export type { OpenApiTagName } from './registry';

export {
  ApiErrorBody,
  ApiErrorCode,
  ValidationIssue,
  errorResponse,
  errorResponses,
} from './common/errors';
export type { ErrorResponseSet } from './common/errors';

export * from './schemas';
