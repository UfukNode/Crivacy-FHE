/**
 * Primitive schema building blocks — the leaves of every other schema.
 *
 * These are deliberately tiny, named, and reused everywhere. Registering
 * them as components (via `.openapi('<Name>')`) means the emitted OpenAPI
 * document has a single definition for e.g. `UuidV4` that every `$ref`
 * points at, instead of inlining the same regex 120 times. That keeps the
 * spec file small, makes cross-referencing in the rendered docs trivial,
 * and forces any later widening/narrowing to be a single-point edit.
 *
 * Brand-preserving helpers (`brandedUuid`, `brandedString`) return a schema
 * whose inferred type carries a nominal brand, so `FirmId` and `ApiKeyId`
 * are not assignable to each other at the TypeScript level even though
 * both are `string` at runtime.
 */

import { z } from '../registry';

/**
 * RFC 4122 UUIDv4 — the canonical opaque identifier shape used for every
 * resource the API exposes externally. The example is a real-looking v4 so
 * Swagger UI's "Try it out" pre-fill lands on a valid value.
 */
export const UuidV4 = z.uuid().openapi('UuidV4', {
  description: 'RFC 4122 UUIDv4.',
  example: '0d1b4f3d-2a9e-4c61-8f08-8a5e2f1e5d7a',
});

export type UuidV4 = z.infer<typeof UuidV4>;

/**
 * ISO 8601 datetime string in UTC. All responses serialize timestamps as
 * strings, not epoch numbers, so the same shape round-trips through JSON
 * without losing precision. We pin UTC because every database column is
 * timestamptz and the JSON payload should never be ambiguous.
 */
export const DateTimeIso = z.iso.datetime({ offset: false }).openapi('DateTimeIso', {
  description: 'ISO 8601 datetime in UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`).',
  example: '2026-04-11T17:45:00.000Z',
});

export type DateTimeIso = z.infer<typeof DateTimeIso>;

/**
 * URL-safe slug used for firm slugs, status component slugs, tag names in
 * the dashboard. Lowercase alphanumerics and dashes, 3–64 chars, must start
 * and end with an alphanumeric. Matches the schema-level `slug` column.
 */
export const Slug = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/, {
    message: 'Must be lowercase alphanumerics and dashes, starting and ending with alphanumeric.',
  })
  .openapi('Slug', {
    description: 'Lowercase alphanumerics + dashes, 3–64 chars.',
    example: 'acme-bank',
  });

export type Slug = z.infer<typeof Slug>;

/**
 * Short human-readable name (firms, API keys, webhook endpoints). Bounded
 * length prevents denial-of-service via huge string payloads and matches
 * varchar(120) in the schema.
 */
export const DisplayName = z.string().min(1).max(120).openapi('DisplayName', {
  description: 'Short human-readable name, 1–120 characters.',
  example: 'Production key',
});

export type DisplayName = z.infer<typeof DisplayName>;

/**
 * RFC 5322-constrained email address. Zod 4 `z.email()` implements a
 * conservative practical regex — not a full RFC parser — which matches
 * what we need for signup, password reset, and webhook notification
 * subscribers. 320 char cap matches the database column.
 */
export const EmailAddress = z.email().max(320).openapi('EmailAddress', {
  description: 'RFC 5322 email address, max 320 characters.',
  example: 'ops@acme-bank.com',
});

export type EmailAddress = z.infer<typeof EmailAddress>;

/**
 * HTTPS URL for webhook callbacks. We explicitly reject `http://` to
 * prevent firms from accidentally leaking event payloads in cleartext.
 */
export const HttpsUrl = z
  .url()
  .refine((value) => value.startsWith('https://'), {
    message: 'URL must use the `https://` scheme.',
  })
  .max(2048)
  .openapi('HttpsUrl', {
    description: 'HTTPS URL, up to 2048 characters.',
    example: 'https://hooks.acme-bank.com/crivacy',
  });

export type HttpsUrl = z.infer<typeof HttpsUrl>;

/**
 * Opaque reference the firm assigns to their end user (e.g. their own
 * user id, UUID, or email). Crivacy treats it as an opaque string and
 * stores it verbatim; the 128-char bound matches the schema column.
 */
export const UserRef = z.string().min(1).max(128).openapi('UserRef', {
  description:
    'Opaque identifier the firm uses for the end user. Any non-empty string up to 128 chars. Stored verbatim and returned verbatim; Crivacy does not interpret the value.',
  example: 'usr_9f8e7d6c',
});

export type UserRef = z.infer<typeof UserRef>;

/**
 * Cursor token used for cursor-pagination. Opaque to the caller; clients
 * must treat it as a server-issued blob. It is base64url-encoded on the
 * wire so it fits in query strings and URLs without escaping.
 */
export const PaginationCursor = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, { message: 'Cursor must be base64url-safe.' })
  .openapi('PaginationCursor', {
    description: 'Opaque base64url pagination cursor issued by the API.',
    example: 'eyJ2IjoxLCJvIjoiMjAyNi0wNC0xMVQxNzo0NTowMFoifQ',
  });

export type PaginationCursor = z.infer<typeof PaginationCursor>;

/**
 * Non-negative 64-bit integer, represented as a JavaScript number for
 * wire-compat with JSON. Values up to `Number.MAX_SAFE_INTEGER`
 * (~9 × 10^15) survive a JSON round trip; any counter we actually emit
 * (rate limits, usage counts, quota remainders) fits comfortably.
 */
export const SafeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).openapi('SafeCount', {
  description: 'Non-negative integer count, JSON-safe (≤ `Number.MAX_SAFE_INTEGER`).',
  example: 42,
});

export type SafeCount = z.infer<typeof SafeCount>;

/**
 * Request ID echoed in the `X-Request-Id` response header and error
 * bodies. UUIDv4 by convention.
 */
export const RequestId = z.uuid().openapi('RequestId', {
  description: 'Server-issued request identifier, UUIDv4.',
  example: 'a12b4c8d-5e9f-4a0b-8c1d-2e3f4a5b6c7d',
});

export type RequestId = z.infer<typeof RequestId>;
