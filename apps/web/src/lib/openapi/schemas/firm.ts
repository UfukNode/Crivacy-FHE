/**
 * Firm profile schemas — dashboard-side reads and writes.
 */

import { DateTimeIso, DisplayName, EmailAddress, HttpsUrl, Slug } from '../common/primitives';
import { z } from '../registry';
import { FirmTier } from './enums';
import { FirmId } from './identifiers';

export const FirmBranding = z
  .object({
    displayName: DisplayName,
    logoUrl: HttpsUrl.nullable(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, { message: 'Must be a 6-char hex color.' })
      .nullable()
      .openapi({ example: '#141414' }),
    supportEmail: EmailAddress.nullable(),
  })
  .openapi('FirmBranding', {
    description: 'Branding applied to Didit flows redirected back to the user.',
  });
export type FirmBranding = z.infer<typeof FirmBranding>;

export const IpAllowlistEntry = z
  .string()
  .regex(/^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)(?:\/\d{1,3})?$/, {
    message: 'Must be an IPv4 or IPv6 address with optional CIDR.',
  })
  .max(64)
  .openapi('IpAllowlistEntry', {
    description: 'Single IPv4 or IPv6 address, optionally in CIDR notation.',
    example: '203.0.113.0/24',
  });
export type IpAllowlistEntry = z.infer<typeof IpAllowlistEntry>;

export const FirmProfile = z
  .object({
    id: FirmId,
    name: z.string().min(1).max(256),
    slug: Slug,
    tier: FirmTier,
    contactEmail: EmailAddress,
    createdAt: DateTimeIso,
    branding: FirmBranding,
    ipAllowlist: z.array(IpAllowlistEntry).max(128),
    dataRetentionDays: z.number().int().min(30).max(3650).openapi({
      description:
        'Retention window for firm-scoped PII (sessions, credentials, deliveries). Minimum 30 days, maximum 3650 (10 years). Defaults to 2555 (7 years KYC compliance).',
      example: 2555,
    }),
  })
  .openapi('FirmProfile', {
    description: 'Full firm profile returned by `GET /api/internal/firm`.',
  });
export type FirmProfile = z.infer<typeof FirmProfile>;

export const FirmUpdateRequest = z
  .object({
    name: z.string().min(1).max(256).optional(),
    contactEmail: EmailAddress.optional(),
    branding: FirmBranding.partial().optional(),
    ipAllowlist: z.array(IpAllowlistEntry).max(128).optional(),
    dataRetentionDays: z.number().int().min(30).max(3650).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field must be provided.',
  })
  .openapi('FirmUpdateRequest', {
    description: 'Payload for `PATCH /api/internal/firm`.',
  });
export type FirmUpdateRequest = z.infer<typeof FirmUpdateRequest>;
