/**
 * Destructive op reauth — TOTP-enrolled audiences (firm + admin).
 *
 * Rolls password + TOTP step-up into a single primitive so the 24
 * destructive endpoints surface identical envelope shapes and identical
 * denial responses. Two-factor pattern protects against the
 * stolen-session-with-known-password threat: rate-limit / lockout / 5min
 * reauth window do nothing when every request carries a valid password —
 * only the second factor blocks that scenario.
 *
 * Customer audience is intentionally NOT supported here: customer
 * accounts have no TOTP enroll path so a `factor: { type: 'totp' }`
 * call would short-circuit with `factor_not_supported`. Customer-side
 * reauth (change-password, change-email, wallet/link) stays password-
 * only by audience design; a wallet+password hybrid is a separate
 * Phase 2-3 candidate.
 *
 * @see lib/auth/reauth.ts — underlying gate primitive.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import type { AuthConfig } from '@/lib/auth/config';
import { reauthFailureResponse, reauthGate } from '@/lib/auth/reauth';
import type { CrivacyDatabase } from '@/lib/db/client';
import type { ApiErrorCode } from '@/lib/openapi/common/errors';
import { parseBody } from '@/server/middleware/parse';
import { existingPasswordSchema, totpCodeSchema } from '@/lib/validation/auth';

/**
 * Single source of truth for the password+TOTP reauth envelope.
 *
 * Spread into endpoint body schemas so every destructive op uses the
 * same field names + the same regex/length rules + the same error
 * messages. Adding a third reauth field (e.g. recoveryCode fallback)
 * here propagates to all 24 endpoints in one edit.
 *
 * Usage:
 *   const Body = z.object({
 *     ...reauthEnvelopeShape,
 *     reason: z.string().max(500).optional(),
 *   });
 */
export const reauthEnvelopeShape = {
  currentPassword: existingPasswordSchema,
  totpCode: totpCodeSchema,
} as const;

export const ReauthEnvelopeSchema = z.object(reauthEnvelopeShape);
export type ReauthEnvelope = z.infer<typeof ReauthEnvelopeSchema>;

export interface RequireTotpReauthInput {
  readonly db: CrivacyDatabase;
  readonly subject: { readonly kind: 'firm' | 'admin'; readonly id: string };
  readonly envelope: ReauthEnvelope;
  readonly now: Date;
  readonly authConfig: AuthConfig;
}

export type RequireTotpReauthResult =
  | {
      readonly status: 'ok';
      /**
       * Argon2id hash that the supplied currentPassword verified
       * against. Pass-through from `reauthGate` so callers that mutate
       * `password_hash` downstream can use it as a `WHERE password_hash
       * = ${hash}` race guard. `null` for accounts without a password
       * on file (currently no firm/admin surface — defensive).
       */
      readonly verifiedPasswordHash: string | null;
    }
  | {
      readonly status: 'denied';
      readonly code: ApiErrorCode;
      readonly message: string;
      readonly httpStatus: number;
    };

/**
 * Verify the caller still owns BOTH the password AND the TOTP factor
 * before allowing a destructive operation to proceed. Returns either
 * an `ok` result with the verified hash, or a `denied` shape the
 * caller passes directly into `ctx.errorJson(code, message, httpStatus)`.
 *
 * The discriminated union keeps the route handler in control of the
 * response — no implicit `ctx` coupling — so the helper is reusable
 * from non-route contexts (background workers, tests) the same way.
 */
export async function requireTotpReauth(
  input: RequireTotpReauthInput,
): Promise<RequireTotpReauthResult> {
  const result = await reauthGate({
    db: input.db,
    subject: input.subject,
    password: input.envelope.currentPassword,
    factor: { type: 'totp', code: input.envelope.totpCode },
    now: input.now,
    authConfig: input.authConfig,
  });
  if (result.status === 'failed') {
    const mapped = reauthFailureResponse(result.reason);
    return {
      status: 'denied',
      code: mapped.code,
      message: mapped.message,
      httpStatus: mapped.status,
    };
  }
  return {
    status: 'ok',
    verifiedPasswordHash: result.verifiedPasswordHash,
  };
}

/**
 * Two-stage parse helper: pulls the destructive-reauth envelope off
 * the request body and returns the remaining keys for the caller to
 * validate against an endpoint-specific schema.
 *
 * Necessary because Next.js consumes the request body stream on the
 * first read; if a route handler reauths AND the underlying handler
 * also calls `parseBody`, the second parse fails with "body already
 * consumed". This helper centralises the single read so:
 *
 *   1. The envelope is shape-validated up front (currentPassword +
 *      totpCode pass `existingPasswordSchema` + `totpCodeSchema`).
 *   2. The caller receives the rest (raw, untyped record) and runs
 *      its own `BodySchema.parse(rest)` for the persisted fields.
 *
 * Equivalent to writing `z.object(reauthEnvelopeShape).passthrough()`
 * inline at every callsite — but the spread/destructure boilerplate
 * lives here once.
 */
export async function parseDestructiveEnvelope(
  request: NextRequest,
): Promise<{
  readonly rest: Record<string, unknown>;
  readonly gate: ReauthEnvelope;
}> {
  const parsed = await parseBody(
    request,
    z.object(reauthEnvelopeShape).passthrough(),
  );
  const { currentPassword, totpCode, ...rest } = parsed;
  return {
    rest: rest as Record<string, unknown>,
    gate: { currentPassword, totpCode },
  };
}
