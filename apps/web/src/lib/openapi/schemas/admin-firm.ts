/**
 * Admin-only firm management schemas.
 */

import { DateTimeIso, DisplayName, EmailAddress, Slug } from '../common/primitives';
import { z } from '../registry';
import { FirmTier } from './enums';
import { FirmId } from './identifiers';

export const AdminFirmCreateRequest = z
  .object({
    name: DisplayName,
    slug: Slug,
    tier: FirmTier.default('free'),
    contactEmail: EmailAddress,
    initialUser: z.object({
      email: EmailAddress,
      role: z.enum(['owner', 'admin']).default('owner'),
    }),
  })
  .openapi('AdminFirmCreateRequest', {
    description: 'Payload for `POST /api/admin/firms`. Creates a firm and its initial owner user.',
  });
export type AdminFirmCreateRequest = z.infer<typeof AdminFirmCreateRequest>;

export const AdminFirmUpdateRequest = z
  .object({
    name: DisplayName.optional(),
    tier: FirmTier.optional(),
    rateLimitPerSec: z.number().int().min(0).max(10_000).optional(),
    monthlyQuotaOverride: z.number().int().min(0).optional(),
    dataRetentionDays: z.number().int().min(30).max(3650).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field must be provided.',
  })
  .openapi('AdminFirmUpdateRequest', {
    description: 'Payload for `PATCH /api/admin/firms/:id`.',
  });
export type AdminFirmUpdateRequest = z.infer<typeof AdminFirmUpdateRequest>;

export const AdminFirmSummary = z
  .object({
    id: FirmId,
    name: DisplayName,
    slug: Slug,
    tier: FirmTier,
    contactEmail: EmailAddress,
    rateLimitPerSec: z.number().int().min(0),
    monthlyQuota: z.number().int().min(0),
    createdAt: DateTimeIso,
    deletedAt: DateTimeIso.nullable(),
    lastActivityAt: DateTimeIso.nullable(),
  })
  .openapi('AdminFirmSummary', {
    description: 'Admin view of a firm. Includes limit overrides and soft-delete state.',
  });
export type AdminFirmSummary = z.infer<typeof AdminFirmSummary>;

export const AdminFirmCreatedResponse = z
  .object({
    firm: AdminFirmSummary,
    passwordResetUrl: z.url().openapi({
      description:
        'One-shot URL the Crivacy operator forwards to the initial firm owner to set their password. Valid for 24 hours.',
    }),
  })
  .openapi('AdminFirmCreatedResponse', {
    description: 'Response for `POST /api/admin/firms`.',
  });
export type AdminFirmCreatedResponse = z.infer<typeof AdminFirmCreatedResponse>;
