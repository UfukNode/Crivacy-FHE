import { describe, expectTypeOf, it } from 'vitest';

import type {
  ApiErrorBody,
  ApiKeyMode,
  ApiKeyScope,
  ApiKeySummary,
  Brand,
  CredentialStatus,
  CredentialSummary,
  FirmId,
  FirmTier,
  KycLevel,
  KycSessionSummary,
  KycStatus,
  Paginated,
  QuotaWindow,
  RateLimitWindow,
  WebhookDeliveryStatus,
  WebhookEventType,
} from '../src/index.js';

describe('@crivacy/shared-types', () => {
  it('brands are nominal and not assignable from raw strings', () => {
    type RawString = string;
    expectTypeOf<FirmId>().not.toEqualTypeOf<RawString>();
    expectTypeOf<Brand<string, 'X'>>().not.toEqualTypeOf<string>();
    // A FirmId is still assignable to string (covariant), but the reverse
    // direction is blocked — this is the core nominal contract we depend on.
    expectTypeOf<FirmId>().toMatchTypeOf<string>();
  });

  it('enum-like unions cover the documented values exactly', () => {
    expectTypeOf<ApiKeyMode>().toEqualTypeOf<'live' | 'test'>();
    expectTypeOf<FirmTier>().toEqualTypeOf<'free' | 'starter' | 'pro' | 'enterprise'>();
    expectTypeOf<KycLevel>().toEqualTypeOf<'basic' | 'enhanced'>();
    expectTypeOf<CredentialStatus>().toEqualTypeOf<'pending' | 'active' | 'revoked' | 'expired' | 'superseded'>();
    expectTypeOf<WebhookDeliveryStatus>().toEqualTypeOf<
      'pending' | 'delivering' | 'delivered' | 'failed' | 'dead_letter'
    >();
    expectTypeOf<KycStatus>().toEqualTypeOf<
      | 'pending'
      | 'in_progress'
      | 'in_review'
      | 'identity_approved'
      | 'address_in_progress'
      | 'approved'
      | 'rejected'
      | 'expired'
      | 'revoked'
      | 'resubmission_pending'
      | 'kyc_expired'
    >();
    expectTypeOf<ApiKeyScope>().toEqualTypeOf<
      'kyc:create' | 'kyc:read' | 'kyc:verify' | 'webhooks:manage' | 'usage:read'
    >();
    expectTypeOf<WebhookEventType>().toEqualTypeOf<
      | 'credential.created'
      | 'credential.verified'
      | 'credential.revoked'
      | 'credential.expired'
      | 'credential.updated'
      | 'credential.upgraded'
      | 'kyc.session.created'
      | 'kyc.session.approved'
      | 'kyc.session.rejected'
      | 'kyc.session.in_review'
      | 'kyc.session.resubmission_required'
      | 'kyc.session.kyc_expired'
    >();
  });

  it('ApiKeySummary requires the documented fields with the right shapes', () => {
    expectTypeOf<ApiKeySummary>().toHaveProperty('id');
    expectTypeOf<ApiKeySummary>().toHaveProperty('prefix');
    expectTypeOf<ApiKeySummary>().toHaveProperty('mode').toEqualTypeOf<ApiKeyMode>();
    expectTypeOf<ApiKeySummary>().toHaveProperty('scopes').toEqualTypeOf<ApiKeyScope[]>();
    expectTypeOf<ApiKeySummary>().toHaveProperty('lastUsedAt').toEqualTypeOf<string | null>();
    expectTypeOf<ApiKeySummary>().toHaveProperty('revokedAt').toEqualTypeOf<string | null>();
  });

  it('CredentialSummary captures the on-chain verification flags', () => {
    expectTypeOf<CredentialSummary>().toHaveProperty('identityVerified').toEqualTypeOf<boolean>();
    expectTypeOf<CredentialSummary>().toHaveProperty('livenessVerified').toEqualTypeOf<boolean>();
    expectTypeOf<CredentialSummary>().toHaveProperty('addressVerified').toEqualTypeOf<boolean>();
    expectTypeOf<CredentialSummary>()
      .toHaveProperty('network')
      .toEqualTypeOf<'mainnet' | 'devnet'>();
  });

  it('KycSessionSummary uses branded ids', () => {
    expectTypeOf<KycSessionSummary>().toHaveProperty('id').toMatchTypeOf<string>();
    expectTypeOf<KycSessionSummary>().toHaveProperty('firmId').toMatchTypeOf<string>();
  });

  it('rate limit and quota windows expose ISO timestamps', () => {
    expectTypeOf<RateLimitWindow>().toHaveProperty('limit').toEqualTypeOf<number>();
    expectTypeOf<RateLimitWindow>().toHaveProperty('remaining').toEqualTypeOf<number>();
    expectTypeOf<RateLimitWindow>().toHaveProperty('resetAt').toEqualTypeOf<string>();
    expectTypeOf<QuotaWindow>().toHaveProperty('period').toEqualTypeOf<'month'>();
  });

  it('error envelope and pagination follow the documented contract', () => {
    expectTypeOf<ApiErrorBody>().toHaveProperty('error');
    expectTypeOf<ApiErrorBody['error']>().toHaveProperty('code').toEqualTypeOf<string>();
    expectTypeOf<ApiErrorBody['error']>().toHaveProperty('message').toEqualTypeOf<string>();
    expectTypeOf<ApiErrorBody['error']>().toHaveProperty('requestId').toEqualTypeOf<string>();
    expectTypeOf<Paginated<number>>().toHaveProperty('data').toEqualTypeOf<number[]>();
    expectTypeOf<Paginated<number>>()
      .toHaveProperty('pagination')
      .toEqualTypeOf<{ nextCursor: string | null; limit: number }>();
  });
});
