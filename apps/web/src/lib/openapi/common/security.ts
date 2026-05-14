/**
 * Security schemes — the four authentication surfaces the API exposes.
 *
 * Each scheme is registered with the OpenAPI registry under a fixed name;
 * route files declare `security: [{ <name>: [] }]` by referencing those
 * names from the `SecurityRequirements` map in this module.
 *
 * 1. `apiKey`: public B2B API, `X-API-Key` header.
 * 2. `sessionCookie`: dashboard, httpOnly `__Host-crv_session` cookie.
 * 3. `adminSessionCookie`: admin console, separate cookie + elevated role.
 * 4. `diditWebhookSignature`: inbound webhook, `X-Signature-V2` HMAC header.
 */

import { registry } from '../registry';

/** Public B2B API — `X-API-Key` header. */
registry.registerComponent('securitySchemes', 'apiKey', {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
  description:
    'Firm API key. Obtainable from the dashboard `Keys` page or via `POST /api/internal/api-keys`. Keys are prefixed `crv_live_` or `crv_test_`.',
});

/** Dashboard session cookie. `__Host-` prefix pins the cookie to HTTPS + root path. */
registry.registerComponent('securitySchemes', 'sessionCookie', {
  type: 'apiKey',
  in: 'cookie',
  name: '__Host-crv_session',
  description:
    'Dashboard session cookie, set by `POST /api/internal/auth/login`. httpOnly, SameSite=Strict, Secure.',
});

/** Admin console session cookie — distinct name so a dashboard session cannot cross-authorize the admin surface. */
registry.registerComponent('securitySchemes', 'adminSessionCookie', {
  type: 'apiKey',
  in: 'cookie',
  name: '__Host-crv_admin_session',
  description: 'Crivacy admin session cookie. Requires the elevated `admin` role claim.',
});

/** Inbound webhook signature. HMAC-SHA256 over the raw request body. */
registry.registerComponent('securitySchemes', 'diditWebhookSignature', {
  type: 'apiKey',
  in: 'header',
  name: 'X-Signature-V2',
  description:
    'Didit webhook signature — HMAC-SHA256 of the raw request body, hex-encoded. Verified against `DIDIT_WEBHOOK_SECRET`.',
});

/**
 * Pre-built security requirement factories for each surface. Route files
 * call one of these in the `security` field on the `registerPath` call.
 * Returning a fresh mutable array from each call keeps zod-to-openapi's
 * type signature (`SecurityRequirementObject[]`) happy — a shared `as
 * const` tuple would be readonly and rejected by the exact-optional
 * strict mode the web app compiles under.
 */
export const SecurityRequirements = {
  apiKey: (): Array<Record<string, string[]>> => [{ apiKey: [] }],
  sessionCookie: (): Array<Record<string, string[]>> => [{ sessionCookie: [] }],
  adminSessionCookie: (): Array<Record<string, string[]>> => [{ adminSessionCookie: [] }],
  diditWebhookSignature: (): Array<Record<string, string[]>> => [{ diditWebhookSignature: [] }],
  /** Public, unauthenticated (health and status endpoints). */
  none: (): Array<Record<string, string[]>> => [],
};

export type SecurityRequirementKey = keyof typeof SecurityRequirements;
