/**
 * Cross-domain enumerations.
 *
 * Every string literal union in `@crivacy/shared-types` that crosses the
 * API boundary has a matching Zod enum here. The two must stay in lock
 * step; the round-trip test in `tests/openapi/enums.test.ts` asserts each
 * Zod enum's options match the TypeScript union one-for-one.
 *
 * Keeping the enums registered as named OpenAPI components means client
 * SDKs generated from the spec get first-class `ApiKeyMode`, `FirmTier`,
 * etc. types instead of plain `string`.
 */

import { z } from '../registry';

export const ApiKeyMode = z.enum(['live', 'test']).openapi('ApiKeyMode', {
  description: 'Whether a key operates against production (`live`) or the playground (`test`).',
  example: 'live',
});
export type ApiKeyMode = z.infer<typeof ApiKeyMode>;

export const ApiKeyScope = z
  .enum(['kyc:create', 'kyc:read', 'kyc:verify', 'webhooks:manage', 'usage:read'])
  .openapi('ApiKeyScope', {
    description: 'Capability scope attached to an API key. A key can hold any subset.',
    example: 'kyc:read',
  });
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

export const FirmTier = z.enum(['free', 'starter', 'pro', 'enterprise']).openapi('FirmTier', {
  description: 'Commercial tier that governs quota, rate limit and feature access.',
  example: 'starter',
});
export type FirmTier = z.infer<typeof FirmTier>;

export const KycLevel = z.enum(['basic', 'enhanced']).openapi('KycLevel', {
  description:
    'Verification depth. `basic` is identity + liveness; `enhanced` adds proof-of-address.',
  example: 'basic',
});
export type KycLevel = z.infer<typeof KycLevel>;

export const KycStatus = z
  .enum([
    'pending',
    'in_progress',
    'in_review',
    'identity_approved',
    'address_in_progress',
    'approved',
    'rejected',
    'expired',
    'revoked',
    'resubmission_pending',
    'kyc_expired',
  ])
  .openapi('KycStatus', {
    description:
      'Lifecycle state of a KYC session. `approved` is the only terminal state that also results in an active on-chain credential. `in_review` (compliance manual review), `resubmission_pending` (user must redo flagged steps), and `kyc_expired` (a previously-approved verification crossed its expiry policy and the on-chain credential was revoked) are non-default states firms should account for in their integration.',
    example: 'in_progress',
  });
export type KycStatus = z.infer<typeof KycStatus>;

export const CredentialStatus = z
  .enum(['pending', 'active', 'revoked', 'expired'])
  .openapi('CredentialStatus', {
    description:
      'Credential lifecycle. `pending` is the (narrow) window between DB insert and on-chain confirmation; all other values represent terminal on-chain facts.',
    example: 'active',
  });
export type CredentialStatus = z.infer<typeof CredentialStatus>;

export const NetworkName = z.enum(['sepolia', 'mainnet', 'devnet']).openapi('NetworkName', {
  description: 'The chain network the credential is issued against.',
  example: 'sepolia',
});
export type NetworkName = z.infer<typeof NetworkName>;

export const ValidatorType = z
  .enum(['DiditValidator', 'ChainValidator', 'ZKValidator'])
  .openapi('ValidatorType', {
    description: 'The validator module that issued the credential on Sepolia.',
    example: 'DiditValidator',
  });
export type ValidatorType = z.infer<typeof ValidatorType>;

export const WebhookEventType = z
  .enum([
    'credential.created',
    'credential.verified',
    'credential.revoked',
    'credential.expired',
    'credential.updated',
    'credential.upgraded',
    'kyc.session.created',
    'kyc.session.approved',
    'kyc.session.rejected',
    // Non-default Didit lifecycle events — fired to firms subscribed
    // so they can surface in-review / resubmission-required / kyc-
    // expired states without polling. `kyc.session.kyc_expired`
    // pairs with `credential.revoked` (the revoke pipeline fires
    // both); subscribing to the session-level event gives firms the
    // before-credential-revoked signal as well.
    'kyc.session.in_review',
    'kyc.session.resubmission_required',
    'kyc.session.kyc_expired',
    // OAuth consent lifecycle — fired to firms subscribed to the
    // event so their own DB can clear cached identity flags when a
    // user revokes access from /settings/connected-apps.
    'oauth.consent.granted',
    'oauth.consent.revoked',
  ])
  .openapi('WebhookEventType', {
    description: 'Events that can be delivered to a firm webhook subscription.',
    example: 'credential.created',
  });
export type WebhookEventType = z.infer<typeof WebhookEventType>;

export const WebhookDeliveryStatus = z
  .enum(['pending', 'delivering', 'delivered', 'failed', 'dead_letter'])
  .openapi('WebhookDeliveryStatus', {
    description: 'Current state of a single webhook delivery attempt.',
    example: 'delivered',
  });
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

export const FirmUserRole = z.enum(['owner', 'admin', 'member', 'viewer']).openapi('FirmUserRole', {
  description: 'Role of a dashboard user within their firm.',
  example: 'member',
});
export type FirmUserRole = z.infer<typeof FirmUserRole>;

export const AdminUserRole = z.enum(['superadmin', 'admin', 'support']).openapi('AdminUserRole', {
  description: 'Crivacy operator role.',
  example: 'admin',
});
export type AdminUserRole = z.infer<typeof AdminUserRole>;

export const StatusComponentState = z
  .enum([
    'operational',
    'degraded_performance',
    'partial_outage',
    'major_outage',
    'under_maintenance',
  ])
  .openapi('StatusComponentState', {
    description: 'Current state of a public status page component.',
    example: 'operational',
  });
export type StatusComponentState = z.infer<typeof StatusComponentState>;

export const IncidentSeverity = z.enum(['minor', 'major', 'critical']).openapi('IncidentSeverity', {
  description: 'Severity classification for an incident on the status page.',
  example: 'minor',
});
export type IncidentSeverity = z.infer<typeof IncidentSeverity>;

export const IncidentStatus = z
  .enum(['investigating', 'identified', 'monitoring', 'resolved'])
  .openapi('IncidentStatus', {
    description: 'Incident lifecycle status — standard status-page vocabulary.',
    example: 'investigating',
  });
export type IncidentStatus = z.infer<typeof IncidentStatus>;

export const AuditActorKind = z
  .enum(['firm_user', 'admin', 'api_key', 'system', 'anonymous'])
  .openapi('AuditActorKind', {
    description: 'Class of actor that authored an audit-log entry.',
    example: 'firm_user',
  });
export type AuditActorKind = z.infer<typeof AuditActorKind>;

export const AuditTargetKind = z
  .enum([
    'firm',
    'firm_user',
    'api_key',
    'session',
    'credential',
    'webhook',
    'incident',
    'component',
    'none',
  ])
  .openapi('AuditTargetKind', {
    description: 'Class of resource an audit-log entry refers to.',
    example: 'api_key',
  });
export type AuditTargetKind = z.infer<typeof AuditTargetKind>;
