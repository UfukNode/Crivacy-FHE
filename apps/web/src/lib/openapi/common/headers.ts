/**
 * Header schemas — request-side headers clients send and response-side
 * headers every response carries.
 *
 * `ResponseConfig.headers` in `@asteasolutions/zod-to-openapi` accepts a
 * `ZodObject`, so the entire response header set is expressed as a plain
 * Zod object: each property name becomes a header name, and the property
 * schema becomes the header's schema in the generated spec.
 *
 * We do NOT call `registry.registerComponent('headers', ...)` here —
 * that code path wants raw OpenAPI `HeaderObject` literals, not Zod
 * schemas, and the inline response-level approach is type-safe.
 */

import { z } from '../registry';

/**
 * Request header sent by every public (API-key-authenticated) call.
 *
 * We deliberately do NOT use `Authorization: Bearer <key>` for firm API
 * keys: bearer tokens are traditionally short-lived and OAuth-issued.
 * Using a dedicated `X-API-Key` header makes intent obvious and lets the
 * rate-limit middleware key off a single well-known header without
 * parsing the `Authorization` value.
 */
export const ApiKeyHeaderSchema = z
  .string()
  .min(10)
  .max(200)
  .regex(/^crv_(live|test)_[A-Za-z0-9_-]{32,}$/, {
    message: 'Must be a `crv_live_*` or `crv_test_*` API key.',
  })
  .openapi({
    description:
      'Firm API key. Prefixed with `crv_live_` (production) or `crv_test_` (playground/test mode).',
    example: 'crv_live_k3n4rqLZ9pFJ8xYh2sQw7VcN5Tm1Xd6Bo',
  });

/**
 * Public-route request header object. Attached to every public route's
 * `request.headers` field so the spec renders an `X-API-Key` requirement
 * alongside the security scheme.
 */
export const PublicRequestHeaders = z
  .object({
    'x-api-key': ApiKeyHeaderSchema,
    'x-idempotency-key': z.string().min(8).max(128).optional().openapi({
      description:
        'Client-supplied idempotency token. Scoped per API key, 24 hour retention. Replaying with the same token returns the original response.',
      example: 'idem_0d1b4f3d2a9e4c618f088a5e2f1e5d7a',
    }),
  })
  .openapi('PublicRequestHeaders', {
    description: 'Headers every public (API-key-authenticated) request must carry.',
  });

/**
 * Response headers shared by every public-route response (2xx and 4xx).
 * Rate-limit telemetry is published on all outcomes so clients can back
 * off proactively without waiting for a 429.
 */
export const publicResponseHeaders = z.object({
  'x-request-id': z.uuid().openapi({
    description: 'Server-issued request identifier for log correlation.',
  }),
  'x-ratelimit-limit': z.number().int().min(0).openapi({
    description: 'Token bucket capacity for the authenticating API key (max in-flight tokens).',
  }),
  'x-ratelimit-remaining': z.number().int().min(0).openapi({
    description: 'Tokens remaining in the bucket after this request.',
  }),
  'x-ratelimit-reset': z.number().int().min(0).openapi({
    description: 'Seconds until the bucket fully refills.',
  }),
});

/**
 * Response headers for internal / admin / webhook routes. Only the
 * request-id is exposed; these routes are not on the public rate limiter.
 */
export const privateResponseHeaders = z.object({
  'x-request-id': z.uuid().openapi({
    description: 'Server-issued request identifier for log correlation.',
  }),
});
