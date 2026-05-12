/**
 * Internal dashboard authentication schemas. These back the session
 * cookie surface (`/api/internal/auth/*`) used only by the dashboard.
 *
 * Passwords are argon2id-hashed at rest. TOTP secrets are AES-GCM
 * encrypted at rest with the application encryption key; TOTP codes are
 * 6 digits, 30 second window, SHA-1 HMAC — standard RFC 6238 parameters.
 */

import { DateTimeIso, EmailAddress } from '../common/primitives';
import { z } from '../registry';
import { FirmTier, FirmUserRole } from './enums';
import { FirmId, FirmUserId } from './identifiers';

export const Password = z.string().min(12).max(256).openapi('Password', {
  description:
    'Plaintext password. Min 12, max 256 chars. Hashing is argon2id and happens server-side.',
  example: 'correct horse battery staple',
});
export type Password = z.infer<typeof Password>;

export const TotpCode = z
  .string()
  .regex(/^[0-9]{6}$/, { message: 'Must be exactly 6 digits.' })
  .openapi('TotpCode', {
    description: 'RFC 6238 TOTP code — 6 digits, SHA-1, 30-second window.',
    example: '482913',
  });
export type TotpCode = z.infer<typeof TotpCode>;

export const LoginRequest = z
  .object({
    email: EmailAddress,
    password: Password,
    totpCode: TotpCode.optional(),
  })
  .openapi('LoginRequest', {
    description: 'Payload for `POST /api/internal/auth/login`.',
  });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const FirmUserSummary = z
  .object({
    id: FirmUserId,
    firmId: FirmId,
    email: EmailAddress,
    role: FirmUserRole,
    totpEnabled: z.boolean(),
    createdAt: DateTimeIso,
    lastLoginAt: DateTimeIso.nullable(),
  })
  .openapi('FirmUserSummary', {
    description: 'Dashboard user view.',
  });
export type FirmUserSummary = z.infer<typeof FirmUserSummary>;

export const FirmLoginContext = z
  .object({
    id: FirmId,
    name: z.string().min(1).max(256),
    tier: FirmTier,
  })
  .openapi('FirmLoginContext', {
    description: 'Minimal firm details returned alongside a successful login.',
  });
export type FirmLoginContext = z.infer<typeof FirmLoginContext>;

export const LoginResponse = z
  .object({
    user: FirmUserSummary,
    firm: FirmLoginContext,
    sessionExpiresAt: DateTimeIso,
    requireTotpSetup: z.boolean().openapi({
      description:
        '`true` when the firm requires TOTP but the current user has not yet enrolled. UI should redirect into the TOTP enrollment flow.',
    }),
  })
  .openapi('LoginResponse', {
    description: 'Response for `POST /api/internal/auth/login`.',
  });
export type LoginResponse = z.infer<typeof LoginResponse>;

export const RefreshResponse = z
  .object({
    sessionExpiresAt: DateTimeIso,
  })
  .openapi('RefreshResponse', {
    description: 'Response for `POST /api/internal/auth/refresh`.',
  });
export type RefreshResponse = z.infer<typeof RefreshResponse>;

export const TotpSetupResponse = z
  .object({
    otpauthUrl: z
      .string()
      .regex(/^otpauth:\/\/totp\//)
      .openapi({
        description: 'RFC 6238 otpauth URL to paste into an authenticator app.',
        example: 'otpauth://totp/Crivacy:ops@acme-bank.com?secret=JBSWY3DPEHPK3PXP&issuer=Crivacy',
      }),
    recoveryCodes: z
      .array(z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/))
      .length(10)
      .openapi({
        description:
          'One-time recovery codes. Displayed once; the server stores only salted hashes.',
      }),
  })
  .openapi('TotpSetupResponse', {
    description: 'Response for `POST /api/internal/auth/totp/setup`.',
  });
export type TotpSetupResponse = z.infer<typeof TotpSetupResponse>;

export const TotpVerifyRequest = z
  .object({
    code: TotpCode,
  })
  .openapi('TotpVerifyRequest', {
    description: 'Payload for `POST /api/internal/auth/totp/verify`.',
  });
export type TotpVerifyRequest = z.infer<typeof TotpVerifyRequest>;

export const TotpVerifyResponse = z
  .object({
    verified: z.boolean(),
    totpEnabledAt: DateTimeIso.nullable(),
  })
  .openapi('TotpVerifyResponse', {
    description: 'Response for `POST /api/internal/auth/totp/verify`.',
  });
export type TotpVerifyResponse = z.infer<typeof TotpVerifyResponse>;
