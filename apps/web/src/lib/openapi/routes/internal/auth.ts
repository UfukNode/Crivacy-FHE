/**
 * Internal dashboard authentication routes.
 *
 * Every endpoint below is mounted under `/api/internal/auth/*`, consumed
 * exclusively by the dashboard UI, and secured by the `__Host-crv_session`
 * cookie. The login endpoint is the only one in this file that does not
 * carry an existing session requirement — it bootstraps the session.
 *
 * Password comparison runs argon2id; TOTP codes are verified against a
 * stored AES-GCM-encrypted secret with a +/- 1 window tolerance to absorb
 * clock drift.
 */

import { SecurityRequirements } from '../../common';
import { OpenApiTags, registry } from '../../registry';
import {
  LoginRequest,
  LoginResponse,
  RefreshResponse,
  TotpSetupResponse,
  TotpVerifyRequest,
  TotpVerifyResponse,
} from '../../schemas/auth';
import { internalNoContentResponses, internalResponses } from '../helpers';

registry.registerPath({
  method: 'post',
  path: '/api/internal/auth/login',
  summary: 'Dashboard login',
  description:
    'Exchanges email + password (+ optional TOTP code) for a session cookie. Returns 401 (`invalid_credentials`) for any failure mode — email enumeration is intentionally impossible. When the firm requires TOTP but the user has not enrolled, the call still succeeds and `requireTotpSetup` is set to `true` so the UI can redirect into the enrollment flow.',
  tags: [OpenApiTags.InternalAuth],
  security: [],
  request: {
    body: {
      description: 'Login credentials.',
      required: true,
      content: {
        'application/json': { schema: LoginRequest },
      },
    },
  },
  responses: internalResponses({
    status: 200,
    description: 'Login successful. `Set-Cookie: __Host-crv_session=...` is attached.',
    schema: LoginResponse,
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/auth/logout',
  summary: 'Dashboard logout',
  description:
    'Invalidates the current dashboard session server-side and clears the cookie via `Set-Cookie: __Host-crv_session=; Max-Age=0`. Idempotent — calling logout without an active session still returns 204.',
  tags: [OpenApiTags.InternalAuth],
  security: SecurityRequirements.sessionCookie(),
  responses: internalNoContentResponses('Session cleared.'),
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/auth/refresh',
  summary: 'Refresh the dashboard session',
  description:
    'Extends the current session expiration by the configured dashboard session length (default 1 hour). Called by the dashboard opportunistically while the user is active.',
  tags: [OpenApiTags.InternalAuth],
  security: SecurityRequirements.sessionCookie(),
  responses: internalResponses({
    status: 200,
    description: 'Session extended. A refreshed cookie is attached.',
    schema: RefreshResponse,
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/auth/totp/setup',
  summary: 'Begin TOTP enrollment',
  description:
    'Generates a new TOTP secret for the current user and returns it as an otpauth URL plus ten one-time recovery codes. The secret is not yet active — the user must confirm by calling `POST /api/internal/auth/totp/verify` with a valid code. Calling setup again before verifying replaces the staged secret.',
  tags: [OpenApiTags.InternalAuth],
  security: SecurityRequirements.sessionCookie(),
  responses: internalResponses({
    status: 200,
    description: 'TOTP enrollment staged.',
    schema: TotpSetupResponse,
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/auth/totp/verify',
  summary: 'Confirm TOTP enrollment or supply a step-up code',
  description:
    'Verifies a 6-digit TOTP code. When a staged secret from `totp/setup` is pending, this call activates it. When TOTP is already enabled, this call performs a step-up for privileged operations and refreshes the session with a short-lived step-up flag.',
  tags: [OpenApiTags.InternalAuth],
  security: SecurityRequirements.sessionCookie(),
  request: {
    body: {
      description: 'TOTP code to verify.',
      required: true,
      content: {
        'application/json': { schema: TotpVerifyRequest },
      },
    },
  },
  responses: internalResponses({
    status: 200,
    description: 'Verification result.',
    schema: TotpVerifyResponse,
  }),
});
