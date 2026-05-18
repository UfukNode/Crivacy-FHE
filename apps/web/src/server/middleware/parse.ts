/**
 * Request parsing utilities for the middleware pipeline.
 *
 * Three parsers, each returning a validated value or throwing:
 *
 *   * `parseBody(request, schema, maxBytes?)` — reads the request JSON
 *     body, enforces a size limit, and validates it against a Zod
 *     schema. Throws `malformed_json` or re-throws ZodError (which the
 *     error-mapper turns into `validation_failed`).
 *
 *   * `parseQuery(url, schema)` — extracts search params from the URL,
 *     builds a plain object, and validates it against a Zod schema.
 *     Keys with multiple values are coerced to arrays.
 *
 *   * `parsePathParams(params, schema)` — awaits Next.js dynamic route
 *     params (which are `Promise<Record<string, string | string[]>>`
 *     in App Router) and validates them.
 *
 * All three are async because the body and path-param APIs are async
 * in Next.js 15. The functions are framework-thin: they receive the
 * raw request or URL, not a context object, so they can be tested
 * without any middleware stack.
 *
 * @module
 */

import type { NextRequest } from 'next/server';
import type { ZodTypeAny, output } from 'zod';

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/**
 * Lightweight error class for parse-stage failures that do not map to
 * a library error (e.g. malformed JSON, payload too large). The
 * error-mapper does not handle these — the route builder catches them
 * and uses `ctx.errorJson()` directly.
 */
export class ParseError extends Error {
  readonly code: 'malformed_json' | 'payload_too_large' | 'unsupported_media_type';

  constructor(code: ParseError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ParseError';
    this.code = code;
  }
}

/**
 * Type guard for `ParseError`.
 */
export function isParseError(value: unknown): value is ParseError {
  return value instanceof ParseError;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum body size: 64 KiB. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// parseBody
// ---------------------------------------------------------------------------

/**
 * Read and validate the JSON request body.
 *
 * 1. Checks `Content-Type` includes `application/json`.
 * 2. Reads the body as text (respects `maxBytes` limit).
 * 3. Parses JSON — throws `ParseError('malformed_json')` on failure.
 * 4. Validates against the Zod schema — throws `ZodError` on failure.
 *
 * Returns the validated, typed output.
 */
export async function parseBody<S extends ZodTypeAny>(
  request: NextRequest,
  schema: S,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<output<S>> {
  // 1. Content-Type guard
  const contentType = request.headers.get('content-type');
  if (contentType === null || !contentType.includes('application/json')) {
    throw new ParseError('unsupported_media_type', 'Content-Type must be application/json.');
  }

  // 2. Read body with size enforcement
  const raw = await readBodyWithLimit(request, maxBytes);

  // 3. JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ParseError('malformed_json', 'Request body is not valid JSON.', { cause });
  }

  // 4. Schema validation (throws ZodError on failure — caught by error-mapper)
  return schema.parse(parsed) as output<S>;
}

/**
 * Read the request body as text, enforcing a byte-length limit.
 * Throws `ParseError('payload_too_large')` if the body exceeds the
 * limit.
 */
async function readBodyWithLimit(request: NextRequest, maxBytes: number): Promise<string> {
  // Check Content-Length header first (fast reject before reading).
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number.parseInt(contentLength, 10);
    if (!Number.isNaN(declared) && declared > maxBytes) {
      throw new ParseError('payload_too_large', `Request body exceeds the ${maxBytes} byte limit.`);
    }
  }

  // Read the full body as text.
  const text = await request.text();

  // Verify actual byte length (Content-Length can be absent or wrong).
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > maxBytes) {
    throw new ParseError('payload_too_large', `Request body exceeds the ${maxBytes} byte limit.`);
  }

  return text;
}

// ---------------------------------------------------------------------------
// parseJsonBody (schema-free)
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON request body without Zod validation.
 *
 * Returns a plain `Record<string, unknown>` after enforcing the byte-length
 * limit and content-type check. Use this for endpoints that perform manual
 * field validation instead of schema-based parsing.
 */
export async function parseJsonBody(
  request: NextRequest,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  // 1. Content-Type guard
  const contentType = request.headers.get('content-type');
  if (contentType === null || !contentType.includes('application/json')) {
    throw new ParseError('unsupported_media_type', 'Content-Type must be application/json.');
  }

  // 2. Read body with size enforcement
  const raw = await readBodyWithLimit(request, maxBytes);

  // 3. JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ParseError('malformed_json', 'Request body is not valid JSON.', { cause });
  }

  // 4. Must be a non-null object
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ParseError('malformed_json', 'Request body must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// parseQuery
// ---------------------------------------------------------------------------

/**
 * Extract search params from a URL and validate against a Zod schema.
 *
 * Duplicate keys are coerced to arrays (e.g. `?tag=a&tag=b` → `{ tag: ['a', 'b'] }`).
 * Single-value keys are strings. This matches the behavior of
 * `URLSearchParams.getAll()`.
 *
 * Throws `ZodError` on validation failure.
 */
export function parseQuery<S extends ZodTypeAny>(url: URL, schema: S): output<S> {
  const raw: Record<string, string | string[]> = {};
  for (const key of url.searchParams.keys()) {
    const values = url.searchParams.getAll(key);
    const first = values[0];
    raw[key] = values.length === 1 && first !== undefined ? first : values;
  }
  return schema.parse(raw) as output<S>;
}

// ---------------------------------------------------------------------------
// parsePathParams
// ---------------------------------------------------------------------------

/**
 * Await and validate Next.js dynamic route params.
 *
 * In Next.js 15 App Router, the `params` prop is `Promise<{ ... }>`.
 * This function awaits it and validates against a Zod schema.
 *
 * Throws `ZodError` on validation failure.
 */
export async function parsePathParams<S extends ZodTypeAny>(
  params: Promise<Record<string, string | string[]>>,
  schema: S,
): Promise<output<S>> {
  const resolved = await params;
  return schema.parse(resolved) as output<S>;
}
