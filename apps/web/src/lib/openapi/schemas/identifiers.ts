/**
 * Branded identifier schemas. Every externally visible id has a distinct
 * named schema so the generated OpenAPI document carries
 * `FirmId`, `ApiKeyId`, `KycSessionId`, etc. as first-class components.
 *
 * Branding is purely TypeScript-side: these are UUIDs at runtime and the
 * Zod validator is identical. The `.brand<'Name'>()` call gives the
 * inferred type a nominal tag that makes it impossible to pass a
 * `KycSessionId` where a `FirmId` is expected at compile time.
 *
 * `UuidV4` is the underlying validator; each branded alias re-registers
 * its own OpenAPI component so the spec has one ref per conceptual id.
 */

import { z } from '../registry';

const BrandedUuid = (name: string, description: string) =>
  z.uuid().openapi(name, { description, example: '0d1b4f3d-2a9e-4c61-8f08-8a5e2f1e5d7a' });

export const FirmId = BrandedUuid('FirmId', 'Unique firm identifier.').brand<'FirmId'>();
export type FirmId = z.infer<typeof FirmId>;

export const FirmUserId = BrandedUuid(
  'FirmUserId',
  'Unique dashboard user identifier.',
).brand<'FirmUserId'>();
export type FirmUserId = z.infer<typeof FirmUserId>;

export const AdminUserId = BrandedUuid(
  'AdminUserId',
  'Unique Crivacy operator identifier.',
).brand<'AdminUserId'>();
export type AdminUserId = z.infer<typeof AdminUserId>;

export const ApiKeyId = BrandedUuid('ApiKeyId', 'Unique API key identifier.').brand<'ApiKeyId'>();
export type ApiKeyId = z.infer<typeof ApiKeyId>;

export const KycSessionId = BrandedUuid(
  'KycSessionId',
  'Unique KYC session identifier.',
).brand<'KycSessionId'>();
export type KycSessionId = z.infer<typeof KycSessionId>;

export const WebhookSubscriptionId = BrandedUuid(
  'WebhookSubscriptionId',
  'Unique webhook subscription identifier.',
).brand<'WebhookSubscriptionId'>();
export type WebhookSubscriptionId = z.infer<typeof WebhookSubscriptionId>;

export const WebhookDeliveryId = BrandedUuid(
  'WebhookDeliveryId',
  'Unique webhook delivery attempt identifier.',
).brand<'WebhookDeliveryId'>();
export type WebhookDeliveryId = z.infer<typeof WebhookDeliveryId>;

export const StatusComponentId = BrandedUuid(
  'StatusComponentId',
  'Unique public status page component identifier.',
).brand<'StatusComponentId'>();
export type StatusComponentId = z.infer<typeof StatusComponentId>;

export const StatusIncidentId = BrandedUuid(
  'StatusIncidentId',
  'Unique public status page incident identifier.',
).brand<'StatusIncidentId'>();
export type StatusIncidentId = z.infer<typeof StatusIncidentId>;

export const AuditLogEntryId = z
  .number()
  .int()
  .min(0)
  .openapi('AuditLogEntryId', {
    description:
      'Monotonic audit log entry id. Sequential by insertion order — safe to use as a cursor token.',
    example: 42,
  })
  .brand<'AuditLogEntryId'>();
export type AuditLogEntryId = z.infer<typeof AuditLogEntryId>;

/**
 * The credential's on-chain reference: the Sepolia transaction hash that
 * wrote the credential to the `CrivacyKYC` contract. We do not parse the
 * shape here — the chain is the authority. Upper bound is generous but
 * finite to defeat DoS.
 */
export const CredentialContractId = z
  .string()
  .min(16)
  .max(512)
  .openapi('CredentialContractId', {
    description: 'Sepolia transaction hash for the credential write on the `CrivacyKYC` contract.',
    example: '0x91f410ffcf51abd0389890968b243bb9a32eb94b6d7c9b3e1f4c2a5d8e7b6a9c3',
  })
  .brand<'CredentialContractId'>();
export type CredentialContractId = z.infer<typeof CredentialContractId>;

/**
 * An EVM address (`0x` + 40 hex). Surfaced read-only on verify responses
 * and credential details — the operator that wrote the credential, the
 * subject that owns it, and the `CrivacyKYC` registry contract.
 */
export const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { message: 'Must be a 0x-prefixed 20-byte EVM address.' })
  .openapi('EvmAddress', {
    description: 'EVM address (`0x` + 40 hex).',
    example: '0x91f410FfCF51abd0389890968b243bb9A32Eb94B',
  })
  .brand<'EvmAddress'>();
export type EvmAddress = z.infer<typeof EvmAddress>;
