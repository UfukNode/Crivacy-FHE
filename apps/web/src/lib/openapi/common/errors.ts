/**
 * Error model — every non-2xx response in the API uses exactly this shape.
 *
 * The envelope matches `ApiErrorBody` in `@crivacy/shared-types`; the two
 * must stay structurally identical so client SDKs never have to branch on
 * which endpoint returned the error. `error` is nested one level deep
 * intentionally — the extra level reserves room to grow (pagination,
 * warnings, hints) without breaking the 1.0 contract.
 *
 * Error codes are enumerated; adding or removing a code is a documented
 * breaking change that must be reflected in the spec diff review. The
 * integer status codes live with the `errorResponses` helper below, so a
 * route file can write `...errorResponses.publicStandard` to attach the
 * full boilerplate response set without re-typing the list every time.
 */

import { registry, z } from '../registry';
import { RequestId } from './primitives';

/**
 * Canonical error codes. Domain concepts are prefixed with the concern
 * they belong to (`kyc_*`, `credential_*`, `webhook_*`) so grepping the
 * codebase for occurrences of a category is trivial. Adding a code is a
 * spec-diff-visible change, which is the whole point.
 */
export const ApiErrorCode = z
  .enum([
    'invalid_request',
    'validation_failed',
    'malformed_json',
    'unauthenticated',
    'invalid_api_key',
    'expired_api_key',
    'invalid_session',
    'totp_required',
    'totp_invalid',
    'recovery_code_invalid',
    'tier_forbidden',
    'scope_forbidden',
    'role_forbidden',
    'permission_denied',
    'ip_blocked',
    'not_found',
    'method_not_allowed',
    'unsupported_media_type',
    'conflict',
    'idempotency_mismatch',
    'credential_revoked',
    'credential_expired',
    'kyc_session_expired',
    'kyc_session_already_terminal',
    'webhook_signature_invalid',
    'webhook_disabled',
    'payload_too_large',
    'rate_limited',
    'quota_exceeded',
    'upstream_unavailable',
    'chain_unavailable',
    'didit_unavailable',
    'account_locked',
    'account_banned',
    // Distinct from `account_banned`: suspended is reversible (support
    // can reinstate), banned is a terminal decision. Client + support
    // flows show different copy / appeal path (AUD-X-ERROR-001).
    'account_suspended',
    'email_not_verified',
    'turnstile_failed',
    'code_expired',
    'code_invalid',
    'code_max_attempts',
    'session_superseded',
    'oauth_failed',
    'challenge_invalid',
    'challenge_ip_mismatch',
    'invite_used',
    'invite_expired',
    'invite_revoked',
    'internal_error',
    'maintenance',
  ])
  .openapi('ApiErrorCode', {
    description:
      'Machine-readable error taxonomy. Clients should branch on this value, not on the human `message`.',
    example: 'validation_failed',
  });

export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/**
 * Validation issue. Mirrors (a subset of) Zod's `ZodIssue` shape so a
 * field-level error can be surfaced back to callers without forcing them
 * to depend on Zod's internals. Path is the dotted path into the input
 * that failed — `"body.userRef"`, `"query.limit"`.
 */
export const ValidationIssue = z
  .object({
    path: z.string().openapi({ example: 'body.userRef' }),
    code: z.string().openapi({ example: 'invalid_type' }),
    message: z.string().openapi({ example: 'Expected string, received number.' }),
  })
  .openapi('ValidationIssue', {
    description: 'Single field-level validation problem on a 400 response.',
  });

export type ValidationIssue = z.infer<typeof ValidationIssue>;

/**
 * The response body. `requestId` is always present — even on 401s — so
 * end-to-end request tracing is unambiguous. `details` is optional and
 * free-form, but for `validation_failed` it carries an `issues` array of
 * `ValidationIssue` objects.
 */
export const ApiErrorBody = z
  .object({
    error: z.object({
      code: ApiErrorCode,
      message: z.string().openapi({
        description: 'Human-readable error summary. Not localized.',
        example: 'Body does not match schema.',
      }),
      requestId: RequestId,
      details: z.record(z.string(), z.unknown()).optional().openapi({
        description:
          'Free-form contextual payload. For `validation_failed` this carries `{ issues: ValidationIssue[] }`.',
      }),
    }),
  })
  .openapi('ApiErrorBody', {
    description: 'Standard error envelope used by every non-2xx response.',
  });

export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

registry.register('ValidationIssue', ValidationIssue);
registry.register('ApiErrorBody', ApiErrorBody);

/**
 * Shorthand for building a single response entry on a route. The body is
 * always `ApiErrorBody`; only the HTTP status and the human description
 * vary. Using a helper prevents route files from diverging on the JSON
 * content-type spelling or forgetting the schema.
 */
export function errorResponse(description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: ApiErrorBody,
      },
    },
  };
}

/**
 * Pre-assembled response sets that cover the standard error surface of
 * a given security tier. Every public route gets `publicStandard`, every
 * internal route gets `internalStandard`, and admin routes layer on an
 * additional 403 description.
 *
 * Listing the statuses here once and reusing them everywhere means the
 * generated spec stays consistent: no orphan 429 on a webhook inbound
 * route, no forgotten 401 on a public route. The typecheck in
 * `tests/openapi/coverage.test.ts` asserts the set-by-set invariants.
 */
export const errorResponses = {
  publicStandard: {
    400: errorResponse(
      'Request failed schema validation (`validation_failed`, `invalid_request`, `malformed_json`).',
    ),
    401: errorResponse(
      'API key missing, malformed, or revoked (`unauthenticated`, `invalid_api_key`, `expired_api_key`).',
    ),
    403: errorResponse(
      'Key scope, firm tier, or IP allowlist disallows this call (`scope_forbidden`, `tier_forbidden`, `ip_blocked`).',
    ),
    404: errorResponse('Resource does not exist or is not visible to the caller (`not_found`).'),
    409: errorResponse('Conflict or idempotency mismatch (`conflict`, `idempotency_mismatch`).'),
    429: errorResponse('Rate limit or monthly quota exhausted (`rate_limited`, `quota_exceeded`).'),
    500: errorResponse('Unhandled server error (`internal_error`).'),
    502: errorResponse(
      'Upstream dependency (chain or Didit) unreachable (`upstream_unavailable`, `chain_unavailable`, `didit_unavailable`).',
    ),
    503: errorResponse('Scheduled maintenance (`maintenance`).'),
  },
  internalStandard: {
    400: errorResponse(
      'Request failed schema validation (`validation_failed`, `invalid_request`, `malformed_json`).',
    ),
    401: errorResponse(
      'Session missing, expired, or TOTP required (`invalid_session`, `totp_required`, `totp_invalid`).',
    ),
    403: errorResponse('Role or scope denies the action (`role_forbidden`, `permission_denied`, `scope_forbidden`).'),
    404: errorResponse('Resource does not exist or is not owned by the firm (`not_found`).'),
    409: errorResponse('Conflict on create/update (`conflict`).'),
    429: errorResponse('Abuse throttle triggered (`rate_limited`).'),
    500: errorResponse('Unhandled server error (`internal_error`).'),
  },
  adminStandard: {
    400: errorResponse(
      'Request failed schema validation (`validation_failed`, `invalid_request`, `malformed_json`).',
    ),
    401: errorResponse('Admin session missing or expired (`invalid_session`).'),
    403: errorResponse('Caller is not a Crivacy admin or lacks the required permission (`role_forbidden`, `permission_denied`).'),
    404: errorResponse('Resource does not exist (`not_found`).'),
    409: errorResponse('Conflict on create/update (`conflict`).'),
    500: errorResponse('Unhandled server error (`internal_error`).'),
  },
  /**
   * Inbound webhook endpoints do not authenticate via API keys; the only
   * auth signal is the provider's HMAC signature. Rate limits and quota
   * do not apply (providers set their own backoff policy).
   */
  inboundWebhookStandard: {
    400: errorResponse('Request failed schema validation (`validation_failed`, `malformed_json`).'),
    401: errorResponse('HMAC signature missing or invalid (`webhook_signature_invalid`).'),
    404: errorResponse('Subscription not found (`not_found`).'),
    413: errorResponse('Payload exceeds the accepted size limit (`payload_too_large`).'),
    500: errorResponse('Unhandled server error (`internal_error`).'),
  },
  /**
   * Public health / status endpoints are unauthenticated and must never
   * 401 or 403. They carry only the shapes a monitoring probe can
   * reasonably encounter.
   */
  healthStandard: {
    500: errorResponse('Unhandled server error (`internal_error`).'),
    503: errorResponse('One or more health checks failed (`maintenance`).'),
  },
} as const;

export type ErrorResponseSet = keyof typeof errorResponses;
